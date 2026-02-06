require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const OpenAI = require('openai');

const app = express();
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ================= GOOGLE AUTH ================= */

const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
const auth = new google.auth.GoogleAuth({
  credentials: serviceAccount,
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});

const SHEET_ID = process.env.SHEET_ID;

const SHEETS_CONFIG = [
  { name: 'Detalle gral - Publi 1', headerRow: 2, range: 'A:Z' },
  { name: 'MOVIMIENTOS', headerRow: 1, range: 'A:Z' },
  { name: 'ARGENTUM', headerRow: 4, range: 'A:Z' },
  { name: 'ROYAL JYG', headerRow: 4, range: 'A:Z' },
  { name: 'TRIBET BUFFA', headerRow: 4, range: 'A:Z' },
  { name: 'TIGER', headerRow: 4, range: 'A:Z' },
  { name: 'MARSHALL', headerRow: 4, range: 'A:Z' },
  { name: 'TOTAL USDT', headerRow: 1, range: 'A:Z' },
];

/* ================= MEMORIA CHAT ================= */

const chatMemory = new Map();
const MAX_HISTORY = 10;

/* ================= CACHE Y ESTADO ================= */

let lastSummary = null;
let lastSheetsHash = null;

/* ================= HELPERS ================= */

async function getSheetValues(sheetName, range) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!${range}`,
  });

  return res.data.values || [];
}

function rowsToObjects(values, headerRowIndex) {
  if (!values.length || values.length < headerRowIndex) return [];

  const headers = values[headerRowIndex - 1].map(h => (h || '').trim());
  return values.slice(headerRowIndex).map(row => {
    const obj = {};
    headers.forEach((h, i) => {
      if (h) obj[h] = row[i] ?? '';
    });
    return obj;
  });
}

async function loadAllSheets() {
  const allData = {};
  for (const sheet of SHEETS_CONFIG) {
    const values = await getSheetValues(sheet.name, sheet.range);
    allData[sheet.name] = rowsToObjects(values, sheet.headerRow);
  }
  return allData;
}

/* ================= FINANCIAL ENGINE ================= */

function buildFinancialSummary(data) {
  const summary = {
    fecha: new Date().toISOString().slice(0, 10),
    resumen_global: {
      total_ingresos: 0,
      total_egresos: 0,
      resultado: 0,
    },
    por_equipo: {},
    alertas: [],
  };

  for (const [sheet, rows] of Object.entries(data)) {
    let ingresos = 0;
    let egresos = 0;

    rows.forEach(r => {
      const monto = Number(r.monto || r.Monto || 0);
      const tipo = (r.tipo || r.Tipo || '').toLowerCase();
      if (tipo === 'ingreso') ingresos += monto;
      if (tipo === 'egreso') egresos += monto;
    });

    summary.por_equipo[sheet] = {
      ingresos,
      egresos,
      pendiente: ingresos - egresos,
      movimientos: rows.length,
    };

    summary.resumen_global.total_ingresos += ingresos;
    summary.resumen_global.total_egresos += egresos;
  }

  summary.resumen_global.resultado =
    summary.resumen_global.total_ingresos -
    summary.resumen_global.total_egresos;

  return summary;
}

function detectChanges(prev, curr) {
  if (!prev) return [];

  const alerts = [];

  if (prev.resumen_global.resultado !== curr.resumen_global.resultado) {
    alerts.push(
      `Resultado global cambió de ${prev.resumen_global.resultado} a ${curr.resumen_global.resultado}`
    );
  }

  for (const team of Object.keys(curr.por_equipo)) {
    if (!prev.por_equipo[team]) continue;

    const p = prev.por_equipo[team];
    const c = curr.por_equipo[team];

    if (p.pendiente !== c.pendiente) {
      alerts.push(`${team}: pendiente ${p.pendiente} → ${c.pendiente}`);
    }

    if (p.movimientos !== c.movimientos) {
      alerts.push(`${team}: movimientos ${p.movimientos} → ${c.movimientos}`);
    }
  }

  return alerts;
}

/* ================= CHATGPT ================= */

function getChatHistory(chatId) {
  if (!chatMemory.has(chatId)) chatMemory.set(chatId, []);
  return chatMemory.get(chatId);
}

function pushHistory(chatId, role, content) {
  const history = getChatHistory(chatId);
  history.push({ role, content });
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
}

async function askChatGPT(chatId, question) {
  const data = await loadAllSheets();
  const summary = buildFinancialSummary(data);

  summary.alertas = detectChanges(lastSummary, summary);
  lastSummary = summary;

  const systemPrompt = `
Sos un analista financiero profesional.
Tu tarea es:
1) Analizar el estado financiero global.
2) Detectar cambios, riesgos y oportunidades.
3) Responder con deducción lógica, precisión numérica y claridad.
`;

  const history = getChatHistory(chatId);

  const response = await openai.responses.create({
    model: 'gpt-5.2-pro',
    input: [
      { role: 'system', content: systemPrompt },
      ...history,
      {
        role: 'user',
        content: `Resumen financiero actualizado:\n${JSON.stringify(summary)}\n\nPregunta: ${question}`,
      },
    ],
  });

  return response.output_text;
}

/* ================= TELEGRAM ================= */

bot.on('message', async msg => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  if (!text || text.startsWith('/')) return;

  try {
    pushHistory(chatId, 'user', text);
    const answer = await askChatGPT(chatId, text);
    pushHistory(chatId, 'assistant', answer);
    bot.sendMessage(chatId, answer);
  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, 'Error procesando datos financieros.');
  }
});

/* ================= SERVER ================= */

app.get('/', (_, res) => res.send('Bot financiero activo'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Servidor listo'));
