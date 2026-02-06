require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const OpenAI = require('openai');

const app = express();
app.use(express.json());

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ================= CONFIG OPENAI ================= */
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const MAX_OUTPUT_TOKENS = 450;

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
const MAX_HISTORY = 8;

/* ================= CACHE ================= */

let cachedSummary = null;
let cachedAt = 0;

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

function parseNumber(value) {
  if (value == null) return 0;
  const cleaned = String(value)
    .replace(/\./g, '')
    .replace(',', '.')
    .replace(/[^\d.-]/g, '');
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : 0;
}

function findFirstValue(row, possibleKeys) {
  for (const key of possibleKeys) {
    if (row[key] != null && row[key] !== '') return row[key];
  }
  return null;
}

function extractDayOfMonth(text) {
  const match = text.match(/día\s+(\d{1,2})/i);
  return match ? Number(match[1]) : null;
}

function parseDateToDay(value) {
  if (!value) return null;
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return d.getDate();
  return null;
}

/* ================= FINANCIAL ENGINE ================= */

function buildFinancialSummary(data, question) {
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

  const dayRequested = extractDayOfMonth(question);

  const MONTO_KEYS = ['monto', 'Monto', 'IMPORTE', 'Importe', 'Total', 'total'];
  const TIPO_KEYS = ['tipo', 'Tipo', 'MOVIMIENTO', 'Movimiento'];
  const FECHA_KEYS = ['fecha', 'Fecha', 'Día', 'Dia'];

  for (const [sheet, rows] of Object.entries(data)) {
    let ingresos = 0;
    let egresos = 0;
    let movimientos = 0;

    rows.forEach(r => {
      if (dayRequested) {
        const fechaVal = findFirstValue(r, FECHA_KEYS);
        const day = parseDateToDay(fechaVal);
        if (day != null && day !== dayRequested) return;
      }

      const montoVal = findFirstValue(r, MONTO_KEYS);
      const tipoVal = findFirstValue(r, TIPO_KEYS);

      const monto = parseNumber(montoVal);
      const tipo = String(tipoVal || '').toLowerCase();

      if (monto || tipo) movimientos++;

      if (tipo.includes('ingreso')) ingresos += monto;
      if (tipo.includes('egreso') || tipo.includes('retiro') || tipo.includes('baja')) egresos += monto;
    });

    summary.por_equipo[sheet] = {
      ingresos,
      egresos,
      pendiente: ingresos - egresos,
      movimientos,
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

/* ================= CACHE REFRESH ================= */

async function refreshCache(questionForContext = '') {
  const data = await loadAllSheets();
  const summary = buildFinancialSummary(data, questionForContext);
  summary.alertas = detectChanges(cachedSummary, summary);
  cachedSummary = summary;
  cachedAt = Date.now();
  return summary;
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
  if (!cachedSummary) {
    await refreshCache(question);
  }

  const systemPrompt = `
Sos un analista financiero profesional.
Tu tarea es:
1) Analizar el estado financiero global.
2) Detectar cambios, riesgos y oportunidades.
3) Responder con deducción lógica, precisión numérica y claridad.
`;

  const history = getChatHistory(chatId);

  const response = await openai.responses.create({
    model: OPENAI_MODEL,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    input: [
      { role: 'system', content: systemPrompt },
      ...history,
      {
        role: 'user',
        content: `Resumen financiero actualizado:\n${JSON.stringify(cachedSummary)}\n\nPregunta: ${question}`,
      },
    ],
  });

  return response.output_text;
}

/* ================= TELEGRAM (WEBHOOK) ================= */

const WEBHOOK_PATH = '/telegram-webhook';
const WEBHOOK_URL = process.env.WEBHOOK_URL;

app.post(WEBHOOK_PATH, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

(async () => {
  try {
    if (!WEBHOOK_URL) {
      console.error('Falta WEBHOOK_URL en variables de entorno.');
      return;
    }
    await bot.setWebHook(`${WEBHOOK_URL}${WEBHOOK_PATH}`, { drop_pending_updates: true });
    console.log('Webhook configurado:', `${WEBHOOK_URL}${WEBHOOK_PATH}`);
  } catch (err) {
    console.error('Error setWebHook:', err);
  }
})();

/* ================= WEBHOOK SHEETS REFRESH ================= */

const REFRESH_SECRET = process.env.REFRESH_SECRET;

// Endpoint que llamará Apps Script
app.post('/sheets-refresh', async (req, res) => {
  try {
    if (!REFRESH_SECRET || req.get('x-refresh-secret') !== REFRESH_SECRET) {
      return res.status(401).send('Unauthorized');
    }
    await refreshCache();
    res.send('OK');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error');
  }
});

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

app.get('/', (_, res) => res.send('Bot financiero activo (webhook)'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Servidor listo'));
