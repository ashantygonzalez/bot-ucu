// server.js
import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import axios from "axios";
import nodemailer from "nodemailer";

dotenv.config();

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_TOKEN = process.env.PAGE_TOKEN;
const {
  LEADS_EMAIL_FROM,
  LEADS_EMAIL_TO,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
} = process.env;

const mailer = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT || 587),
  secure: Number(SMTP_PORT) === 465, // true si usas 465
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});

// ===================== STATE (memoria por PSID) =====================
/**
 * psid -> {
 *   intent: "contado" | "ubicacion" | "financiamiento" | "promo6" | null,
 *   nombre: string|null,
 *   tempName: string|null,   // para confirmar
 *   whatsapp: string|null,   // +52XXXXXXXXXX
 *   step: "ask_name"|"ask_phone"|"ask_schedule"|"collecting"|null,
 *   agenda_text: string|null // texto libre del horario preferido
 * }
 */
const S = new Map();

// en getSession
function getSession(psid) {
  if (!S.has(psid)) {
    S.set(psid, {
    intent: null,
    nombre: null,
    tempName: null,
    whatsapp: null,
    step: null,
    schedule_day: null,
    schedule_time: null,
    agenda_text: null,
    awaitingYesNo: null,
    awaitingCallPref: false,     // <-- NUEVO
    });
  }
  return S.get(psid);
}

function resetLead(psid) {
  S.set(psid, {
  intent: null,
  nombre: null,
  tempName: null,
  whatsapp: null,
  step: null,
  schedule_day: null,
  schedule_time: null,
  agenda_text: null,
  awaitingYesNo: null,
  awaitingCallPref: false,     // <-- NUEVO
});
}


// ===================== CONTEXTO =====================

function contextLabel(intent) {
  switch (intent) {
    case "contado":        return "tu cotización en pago de contado";
    case "ubicacion":      return "enviarte la ubicación y darte seguimiento";
    case "financiamiento": return "armar tu plan de financiamiento";
    case "promo6":         return "enviarte los detalles de la promoción a 6 meses";
    case "apartar":        return "procesar tu apartado de $5,000";
    default:               return "continuar con tu solicitud";
  }
}

// ===================== VALIDADORES =====================
function normalizeName(name) {
  return name
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function extractName(text) {
  const t = text.trim();

  // 1) Frases comunes
  const patterns = [
    /mi\s+nombre\s+es[:\s]+([a-záéíóúüñ\s']{3,60})$/i,
    /me\s+llamo\s+([a-záéíóúüñ\s']{3,60})$/i,
    /soy\s+([a-záéíóúüñ\s']{3,60})$/i,
    /(?:^|\b)nombre\s*[:\-]\s*([a-záéíóúüñ\s']{3,60})$/i
  ];
  for (const rx of patterns) {
    const m = t.match(rx);
    if (m?.[1]) {
      const cand = normalizeName(m[1].replace(/[^a-záéíóúüñ\s']/gi, ""));
      const words = cand.split(" ");
      if (words.length >= 2 && /^[a-záéíóúüñ\s']+$/i.test(cand)) return cand;
    }
  }

  // 2) Fallback: parece nombre suelto (dos+ palabras, letras/espacios)
  const cleaned = t.replace(/[^a-záéíóúüñ\s']/gi, " ").replace(/\s+/g, " ").trim();
  if (/^[a-záéíóúüñ\s']+$/i.test(cleaned)) {
    const cand = normalizeName(cleaned);
    const words = cand.split(" ");
    if (words.length >= 2) return cand;
  }

  return null;
}

// --- Sí y no ---

function setAwaitingYesNo(psid, yesPayload, noPayload) {
  const s = getSession(psid);
  s.awaitingYesNo = { yesPayload, noPayload };
}
function clearAwaitingYesNo(psid) {
  const s = getSession(psid);
  s.awaitingYesNo = null;
}
function isYes(text) {
  const t = text.trim().toLowerCase();
  return /^s[ií]\b/.test(t) || /\bs[ií]\b/.test(t); 
}

function isNo(text) {
  const t = text.trim().toLowerCase();
  return /^no\b/.test(t) || /\bno\b/.test(t);
}

function sanitizeSession(session) {
  session.awaitingYesNo = null;
  session.awaitingCallPref = false;
}

// --- Días de la semana (ES) ---
const WEEKDAYS = {
  "lunes": "lunes",
  "martes": "martes",
  "miercoles": "miércoles",
  "miércoles": "miércoles",
  "jueves": "jueves",
  "viernes": "viernes",
  "sabado": "sábado",
  "sábado": "sábado",
  "domingo": "domingo"
};

function parseWeekdayEs(text) {
  const t = text.trim().toLowerCase()
    .replace(/[.]/g, "")
    .replace(/\s+/g, " ");
  // aceptar "el lunes", "para el sábado", etc.
  const m = t.match(/(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)/i);
  if (!m) return null;
  const raw = m[1].normalize("NFD").replace(/[\u0300-\u036f]/g, ""); // quitar acentos para map básico
  const key = raw.replace("miercoles","miércoles").replace("sabado","sábado");
  return WEEKDAYS[key] || WEEKDAYS[raw] || null;
}

// --- Horarios ---
function pad2(n){ return n.toString().padStart(2,"0"); }

/**
 * Acepta:
 *  - 24h: "9:00", "09:30", "21:15"
 *  - 12h: "9 am", "9:30 pm", "12 pm", "12:05am"
 * Devuelve: { hhmm24: "HH:MM", display: "HH:MM" }
 */
function parseTimeEs(text) {
  const t = text.trim().toLowerCase().replace(/\s+/g, " ");

  // 12h con am/pm
  let m = t.match(/^(\d{1,2})(?::(\d{1,2}))?\s*(a\.?m\.?|p\.?m\.?|am|pm)$/i);
  if (m) {
    let h = parseInt(m[1],10);
    let min = parseInt(m[2] ?? "0",10);
    const mer = m[3].replace(/\./g,"");
    if (h < 1 || h > 12 || min < 0 || min > 59) return null;
    if (mer === "pm" && h !== 12) h += 12;
    if (mer === "am" && h === 12) h = 0;
    return { hhmm24: `${pad2(h)}:${pad2(min)}`, display: `${pad2(h)}:${pad2(min)}` };
  }

  // 24h
  m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    let h = parseInt(m[1],10);
    let min = parseInt(m[2],10);
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    return { hhmm24: `${pad2(h)}:${pad2(min)}`, display: `${pad2(h)}:${pad2(min)}` };
  }

  // variantes simples "9pm", "930pm"
  m = t.match(/^(\d{1,2})(?::?(\d{2}))?\s*(am|pm)$/);
  if (m) {
    let h = parseInt(m[1],10);
    let min = parseInt(m[2] ?? "0",10);
    const mer = m[3];
    if (h < 1 || h > 12 || min < 0 || min > 59) return null;
    if (mer === "pm" && h !== 12) h += 12;
    if (mer === "am" && h === 12) h = 0;
    return { hhmm24: `${pad2(h)}:${pad2(min)}`, display: `${pad2(h)}:${pad2(min)}` };
  }

  return null;
}

function extractPhoneMX(text) {
  const digits = (text.match(/\d+/g) || []).join("");
  let ten = null;
  if (digits.startsWith("52") && digits.length >= 12) ten = digits.slice(-10);
  else if (digits.length === 10) ten = digits;
  if (!ten) return null;
  if (!/^[2-9]\d{9}$/.test(ten)) return null; // 10 dígitos, empieza 2–9
  return `+52${ten}`;
}

function hasBoth(session) {
  return !!(session.nombre && session.whatsapp);
}

// ===================== SENDERS =====================
async function sendText(psid, text) {
  await axios.post(
    "https://graph.facebook.com/v19.0/me/messages",
    { recipient: { id: psid }, message: { text } },
    { params: { access_token: PAGE_TOKEN } }
  );
}

async function sendButtons(psid, text, buttons) {
  await axios.post(
    "https://graph.facebook.com/v19.0/me/messages",
    {
      recipient: { id: psid },
      message: {
        attachment: {
          type: "template",
          payload: { template_type: "button", text, buttons }
        }
      }
    },
    { params: { access_token: PAGE_TOKEN } }
  );
}

async function sendYesNo(psid, text, yesPayload, noPayload) {
  await sendButtons(psid, text, [
    { type: "postback", title: "✅ Sí", payload: yesPayload },
    { type: "postback", title: "❌ No", payload: noPayload }
  ]);
}

// ===================== PROMPTS =====================
async function showMenu(psid) {
  await sendButtons(psid, "Hola mucho gusto 🌅 Soy el asistente de Moisés Santillán/Grupo Linderos. ¿Qué info te interesa primero?",
    [
      { type: "postback", title: "1️⃣ Precio de contado", payload: "OPC_CONTADO" },
      { type: "postback", title: "2️⃣ Ubicación y medidas", payload: "OPC_UBICACION" },
      { type: "postback", title: "3️⃣ Financiamiento", payload: "OPC_FINAN" }
    ]
  );
  await sendButtons(psid, "También tengo:",
    [
      { type: "postback", title: "4️⃣ Promoción a 6 meses", payload: "OPC_PROMO6" },
      { type: "postback", title: "🟢 Apartar ahora", payload: "OPC_APARTAR" }
    ]
  );
}

async function continueAfterLocation(psid) {
  await sendButtons(psid, "¿Qué te gustaría ver ahora?", [
    { type: "postback", title: "💵 Precio de contado", payload: "OPC_CONTADO" },
    { type: "postback", title: "📝 Financiamiento", payload: "OPC_FINAN" },
    { type: "postback", title: "🎉 Promo 6 meses", payload: "OPC_PROMO6" }
  ]);
  await sendButtons(psid, "También puedo:", [
    { type: "postback", title: "🟢 Apartar ahora", payload: "OPC_APARTAR" },
  ]);
}

async function sendLeadEmail({ intent, nombre, whatsapp, preferencia, agenda_text, psid }) {
  const asunto = `Nuevo lead Ucú (${intent}) - ${nombre}`;
  const html = `
    <h2>Nuevo lead de Messenger</h2>
    <ul>
      <li><b>Intent:</b> ${intent}</li>
      <li><b>Nombre:</b> ${nombre}</li>
      <li><b>WhatsApp:</b> ${whatsapp}</li>
      <li><b>Preferencia:</b> ${preferencia}</li>
      ${agenda_text ? `<li><b>Horario:</b> ${agenda_text}</li>` : ""}
      <li><b>PSID:</b> ${psid}</li>
      <li><b>Fecha:</b> ${new Date().toLocaleString()}</li>
    </ul>
  `.trim();

  await mailer.sendMail({
    from: LEADS_EMAIL_FROM,
    to: LEADS_EMAIL_TO,
    subject: asunto,
    html,
  });
}

async function askName(psid) {
  const session = getSession(psid);
  const ctx = contextLabel(session.intent);

  await sendText(psid, `Para ${ctx}, ¿me compartes tu **nombre completo**?`);
  await sendText(psid, "Puedes escribir: *Mi nombre es Ana López* o *Me llamo Ana López* 🙂");
}

async function askPhone(psid) {
  await sendText(psid, "¡Gracias! Ahora pásame tu **WhatsApp** (10 dígitos). Ej.: *mi número es 9991234567* 📲");
}

async function confirmName(psid, name) {
  await sendButtons(psid, `¿Confirmas que tu nombre es **${name}**?`, [
    { type: "postback", title: "✅ Sí",  payload: "NAME_CONFIRM_YES" },
    { type: "postback", title: "❌ No",  payload: "NAME_CONFIRM_NO" }
  ]);

  setAwaitingYesNo(psid, "NAME_CONFIRM_YES", "NAME_CONFIRM_NO");
}

async function askCallPref(psid) {
  const session = getSession(psid);
  const texto = (session.intent === "apartar")
    ? "👉 ¿Quieres que Moisés te contacte *ahora* o prefieres *agendar* para procesar tu **apartado de $5,000**? ⏰"
    : "👉 ¿Quieres que Moisés te marque *ahora* o prefieres *agendar* un horario? ⏰";

  await sendButtons(psid, texto, [
    { type: "postback", title: "📞 Ahora", payload: "LLAMAR_AHORA" },
    { type: "postback", title: "⏰ Agendar", payload: "AGENDAR" }
  ]);

  session.awaitingCallPref = true;

}

async function askScheduleDay(psid) {
  await sendText(psid, "⏰ Para agendar, dime primero un **día de la semana** (lunes a domingo).");
  await sendText(psid, "Ejemplos: *lunes*, *miércoles*, *sábado*");
}
async function askScheduleTime(psid) {
  await sendText(psid, "Genial. Ahora dime la **hora**. Acepto 24h (*18:30*) o 12h (*6:30 pm*).");
}
async function confirmSchedule(psid, day, hhmm) {
  await sendButtons(psid, `¿Confirmo tu horario como: **${day} ${hhmm}**?`, [
    { type: "postback", title: "✅ Sí",  payload: "SCHEDULE_CONFIRM_YES" },
    { type: "postback", title: "❌ No",  payload: "SCHEDULE_CONFIRM_NO" }
  ]);

  setAwaitingYesNo(psid, "SCHEDULE_CONFIRM_YES", "SCHEDULE_CONFIRM_NO");

}

// ===================== RAMAS (con Sí/No) =====================
async function handleContado(psid) {
  await sendText(psid, "Los terrenos son de 500 m² y el *precio de contado* es de *$185,000* 💵\nCon este plan tienes *escrituración inmediata* 🖊️");
  await sendYesNo(psid, "👉 ¿Quieres que Moisés te prepare tu cotización en pago de contado? 📲", "CONTADO_SI", "CONTADO_NO");
  setAwaitingYesNo(psid, "CONTADO_SI", "CONTADO_NO");
  const session = getSession(psid);
  session.intent = "contado";
}

async function handleApartar(psid) {
  await sendText(psid, "¡Excelente decisión! 🟢 El *apartado es de $5,000* para asegurar tu lote en Ucú.");
  await sendYesNo(psid, "👉 ¿Quieres avanzar *ahora mismo* con tu apartado?", "APARTAR_SI", "APARTAR_NO");
  setAwaitingYesNo(psid, "APARTAR_SI", "APARTAR_NO");
  const session = getSession(psid);
  session.intent = "apartar";
}

async function handleUbicacion(psid) {
  await sendText(psid, "Nuestros terrenos están en *Ucú, Yucatán*, a solo *15 minutos del periférico Mérida* 🚗");
  await sendText(psid, "Cada lote mide *500 m² (10 x 50 aprox.)* 📐\nEs una zona de *alto crecimiento* y formamos parte del proyecto *Renacimiento Maya* 🏡");
  await sendYesNo(psid, "👉 ¿Quieres que te comparta la ubicación en Google Maps para que veas qué tan cerca está? 🌎", "UBICACION_SI", "UBICACION_NO");
  setAwaitingYesNo(psid, "UBICACION_SI", "UBICACION_NO");
  const session = getSession(psid);
  session.intent = "ubicacion";
}

async function handleFinan(psid) {
  await sendText(psid, "¡Claro! 🙌 Puedes *apartar con $5,000* y dar un *enganche desde el 20%*.");
  await sendText(psid, "Después eliges un plan de *hasta 36 meses* 🗓️");
  await sendYesNo(psid, "👉 ¿Quieres que te muestre la tabla de pagos mensuales y te arme la mejor opción? 💵", "FINAN_SI", "FINAN_NO");
  const session = getSession(psid);
  session.intent = "financiamiento";
}

async function handlePromo6(psid) {
  await sendText(psid, "Este mes tenemos una *promo especial a 6 meses* 🔥");
  await sendText(psid, "Con *pago diferido* puedes asegurar tu terreno más rápido y con *beneficios exclusivos* ✨");
  await sendYesNo(psid, "👉 ¿Quieres que Moisés te dé los detalles de la promo y te reserve tu lote? 📲", "PROMO6_SI", "PROMO6_NO");
  setAwaitingYesNo(psid, "PROMO6_SI", "PROMO6_NO");
  const session = getSession(psid);
  session.intent = "promo6";
}

async function handlePostback(psid, p) {
  const session = getSession(psid);

  // Menú principal
  if (p === "GET_STARTED") { sanitizeSession(session); await showMenu(psid); return; }
  if (p === "OPC_CONTADO") { sanitizeSession(session); await handleContado(psid); return; }
  if (p === "OPC_UBICACION") { sanitizeSession(session); await handleUbicacion(psid); return; }
  if (p === "OPC_FINAN") { sanitizeSession(session); await handleFinan(psid); return; }
  if (p === "OPC_PROMO6") { sanitizeSession(session); await handlePromo6(psid); return; }
  if (p === "OPC_APARTAR") { sanitizeSession(session); await handleApartar(psid); return; }

  // Sí/No por rama -> Si = pedir datos con copy contextual, No = volver a menú
  if (p === "CONTADO_SI" || p === "FINAN_SI" || p === "PROMO6_SI") {
    const ctx = contextLabel(session.intent);
    session.step = "ask_name";
    await askName(psid);                  // (quitamos el “¡Excelente! …” para no duplicar)
    clearAwaitingYesNo(psid);
    return;
  }

  if (p === "UBICACION_SI") {
    await sendText(psid, "🗺️ Ubicación en Google Maps:\nhttps://maps.app.goo.gl/MCdjyEouQhxTnUbx5");
    await continueAfterLocation(psid);
    clearAwaitingYesNo(psid);
    return;
  }

  if (p === "CONTADO_NO" || p === "UBICACION_NO" || p === "FINAN_NO" || p === "PROMO6_NO") {
    await sendText(psid, "¡Sin problema! Te dejo el menú por si quieres ver otra opción 👇");
    resetLead(psid);
    await showMenu(psid);
    clearAwaitingYesNo(psid);
    return;
  }

  // Apartar: Sí/No
  if (p === "APARTAR_SI") {
    const ctx = contextLabel(session.intent); // será "apartar"
    if (!hasBoth(session)) {
      session.step = session.nombre ? "ask_phone" : "ask_name";
      if (session.step === "ask_name") await askName(psid);
      else await askPhone(psid);
    } else {
      await askCallPref(psid);
    }
    clearAwaitingYesNo(psid);
    return;
  }
  if (p === "APARTAR_NO") {
    await sendText(psid, "¡Sin problema! Si quieres revisar más info antes, aquí está el menú 👇");
    resetLead(psid);
    await showMenu(psid);
    clearAwaitingYesNo(psid);
    return;
  }

  // Confirmación de nombre
  if (p === "NAME_CONFIRM_YES") {
    if (session.tempName) {
      session.nombre = session.tempName;
      session.tempName = null;
      await sendText(psid, `Perfecto, *${session.nombre}* ✅`);
      session.step = "ask_phone";
      await askPhone(psid);
    } else {
      session.step = "ask_name";
      await askName(psid);
    }
    return;
  }
  if (p === "NAME_CONFIRM_NO") {
    session.tempName = null;
    session.nombre = null;
    session.step = "ask_name";
    await sendText(psid, "Sin problema, escríbelo de nuevo por fa (nombre y apellido).");
    await askName(psid);
    return;
  }

  // CTA final (solo si ya hay datos): Ahora / Agendar
  if (p === "LLAMAR_AHORA") {
    session.awaitingCallPref = false; 
    if (!hasBoth(session)) {
      session.step = session.nombre ? "ask_phone" : "ask_name";
      if (session.step === "ask_name") await askName(psid);
      else await askPhone(psid);
      return;
    }
    await sendText(psid, "¡Listo! ✅ Le aviso a Moisés que te contacte *ahora*. ¡Gracias!");
    await sendLeadEmail({
      intent: session.intent,
      nombre: session.nombre,
      whatsapp: session.whatsapp,
      preferencia: "ahora",
      agenda_text: null,
      psid
    });
    resetLead(psid);
    await sendText(psid, "Si quieres ver otra opción, elige del menú 👇");
    await showMenu(psid);
    return;
  }

  if (p === "AGENDAR") {
    session.awaitingCallPref = false; 
    if (!hasBoth(session)) {
      session.step = session.nombre ? "ask_phone" : "ask_name";
      if (session.step === "ask_name") await askName(psid);
      else await askPhone(psid);
      return;
    }
    session.step = "ask_schedule_day";
    session.schedule_day = null;
    session.schedule_time = null;
    await askScheduleDay(psid);
    return;
  }

  if (p === "SCHEDULE_CONFIRM_YES") {
    clearAwaitingYesNo(psid);
    if (!hasBoth(session) || !session.schedule_day || !session.schedule_time) {
      session.step = "ask_schedule_day";
      session.schedule_day = null;
      session.schedule_time = null;
      await sendText(psid, "Vamos a intentarlo de nuevo 😉");
      await askScheduleDay(psid);
      return;
    }
    await sendText(psid, "¡Perfecto! ✅ Agendo esa hora y le aviso a Moisés para que te contacte.");
    await sendLeadEmail({
      intent: session.intent,
      nombre: session.nombre,
      whatsapp: session.whatsapp,
      preferencia: "agendar",
      agenda_text: session.agenda_text || `${session.schedule_day} ${session.schedule_time}`,
      psid
    });
    resetLead(psid);
    await sendText(psid, "¿Quieres ver otra opción? Aquí tienes el menú 👇");
    await showMenu(psid);
    return;
  }

  if (p === "SCHEDULE_CONFIRM_NO") {
    clearAwaitingYesNo(psid);
    session.schedule_time = null;
    session.agenda_text = null;
    session.step = "ask_schedule_day";
    await sendText(psid, "Ok, intentémoslo de nuevo. Dime un **día de la semana** (lunes a domingo).");
    await askScheduleDay(psid);
    return;
  }

  // Fallback
  console.log("Payload no reconocido:", p);
}

// ===================== VERIFICACIÓN WEBHOOK =====================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado ✅");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ===================== EVENTOS WEBHOOK =====================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    if (req.body.object !== "page") return;

    for (const entry of req.body.entry) {
      const event = entry.messaging?.[0];
      if (!event) continue;

      const psid = event.sender.id;
      const session = getSession(psid);

     if (event.postback?.payload) {
    await handlePostback(psid, event.postback.payload);
    continue;
    }

      // -------- MENSAJE DE TEXTO --------
    if (event.message?.text) {
    const text = event.message.text.trim();

    // Elección escrita de "ahora" / "agendar"
    if (session.awaitingCallPref) {
    const t = text.toLowerCase().trim();

    const wantsNow =
        /\bahora\b/.test(t) ||
        /\bde una\b/.test(t) ||
        /\ben este momento\b/.test(t) ||
        /(ll[aá]men|marquen|llamar|hablen|me hablen|me llamen).*(ya|ahora|en este momento)/.test(t) ||
        /(quiero|prefiero).*(llamada|me hablen|me llamen|me marquen).*(ya|ahora|en este momento)/.test(t) ||
        /(quiero|prefiero).*(ahora|de una)/.test(t);

    const wantsLater =
        /(agendar|agenda|programar|agendemos|citar|cita)/.test(t) ||
        /(quiero|prefiero).*(agendar|agenda|programar|cita|despu[eé]s|m[aá]s tarde|mas tarde)/.test(t) ||
        /\b(despu[eé]s|m[aá]s tarde|mas tarde)\b/.test(t);

    if (wantsNow && !wantsLater) {
        session.awaitingCallPref = false;
        await handlePostback(psid, "LLAMAR_AHORA");
        continue;
    }
    if (wantsLater && !wantsNow) {
        session.awaitingCallPref = false;
        await handlePostback(psid, "AGENDAR");
        continue;
    }

    await sendButtons(psid, "¿Prefieres que te contactemos **ahora** o **agendar** un horario? ⏰", [
        { type: "postback", title: "📞 Ahora", payload: "LLAMAR_AHORA" },
        { type: "postback", title: "⏰ Agendar", payload: "AGENDAR" }
    ]);
    continue;
    }

    // Pasos guiados primero
    if (session.step === "ask_name") {

        if (isYes(text)) {
            await handlePostback(psid, "NAME_CONFIRM_YES");
            continue;
        }
        if (isNo(text)) {
            await handlePostback(psid, "NAME_CONFIRM_NO");
            continue;
        }
        
        const name = extractName(text);
        if (name) {
        session.tempName = name;
        await confirmName(psid, name); // Sí/No
        } else {
        await sendText(psid, "No me quedó claro 😅. Escribe tu *nombre completo* (nombre y apellido).");
        await askName(psid);
        }
        continue;
    }

    // Si estamos esperando un Sí/No y el usuario escribe "sí" o "no"
    if (session.awaitingYesNo && (isYes(text) || isNo(text))) {
    const payload = isYes(text) ? session.awaitingYesNo.yesPayload
                                : session.awaitingYesNo.noPayload;
    session.awaitingYesNo = null; // limpiar
    await handlePostback(psid, payload);  // <-- procesar de inmediato
    continue;
    }

    if (session.step === "ask_phone") {
        const phone = extractPhoneMX(text);
        if (phone) {
        session.whatsapp = phone;
        await sendText(psid, `Guardé tu WhatsApp: *${phone}* ✅`);
        if (hasBoth(session)) {
            await askCallPref(psid);
        } else {
            session.step = "ask_name";
            await askName(psid);
        }
        } else {
        await sendText(psid, "El WhatsApp debe tener **10 dígitos** en México. Ej.: 9991234567");
        await askPhone(psid);
        }
        continue;
    }

    // 1) pedir día
    if (session.step === "ask_schedule_day") {
        const day = parseWeekdayEs(text);
        if (!day) {
        await sendText(psid, "No identifiqué un día válido 😅. Dime un día de la semana: *lunes* a *domingo*.");
        await askScheduleDay(psid);
        continue;
        }
        session.schedule_day = day;
        session.step = "ask_schedule_time";
        await sendText(psid, `Perfecto, **${day}**.`);
        await askScheduleTime(psid);
        continue;
    }

    // 2) pedir hora
    if (session.step === "ask_schedule_time") {
        const t = parseTimeEs(text);
        if (!t) {
        await sendText(psid, "No reconocí la hora 😅. Ejemplos válidos: *18:30*, *6:30 pm*, *9 am*.");
        await askScheduleTime(psid);
        continue;
        }
        session.schedule_time = t.hhmm24;
        session.agenda_text = `${session.schedule_day} ${t.display}`;
        await confirmSchedule(psid, session.schedule_day, t.display);
        continue;
    }


    // Palabras clave si no están en pasos
    if (/contado|precio/i.test(text)) { await handleContado(psid); continue; }
    if (/ubicaci[óo]n|medidas|d[oó]nde/i.test(text)) { await handleUbicacion(psid); continue; }
    if (/financia|mensual|mensuales|enganche|engache|meses|plan|financiamiento|pago/i.test(text)) { await handleFinan(psid); continue; }
    if (/promo|promoci[óo]n|6\s*meses/i.test(text)) { await handlePromo6(psid); continue; }
    if (/apartar|reservar|apartad[oa]/i.test(text)) { await handleApartar(psid); continue; }

    // Si no hay flujo activo, muestra menú
    await showMenu(psid);
    }
    }
  } catch (e) {
    console.error("Error webhook:", e?.response?.data || e.message);
  }
});

app.listen(PORT, () => console.log(`Bot escuchando en http://localhost:${PORT} 🌳`));