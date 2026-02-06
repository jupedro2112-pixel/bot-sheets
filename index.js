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
  { name: 'Detalle gral - Publi 1', headerRow: 2, range: 'A:AB' },
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
  const rawData = {};
  for (const sheet of SHEETS_CONFIG) {
    const values = await getSheetValues(sheet.name, sheet.range);
    rawData[sheet.name] = values;
    allData[sheet.name] = rowsToObjects(values, sheet.headerRow);
  }
  return { allData, rawData };
}

function parseNumber(value) {
  if (value == null || value === '') return 0;
  const cleaned = String(value)
    .replace(/\./g, '')
    .replace(',', '.')
    .replace(/[^\d.-]/g, '');
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : 0;
}

function extractDayOfMonth(text) {
  const match = text.match(/día\s+(\d{1,2})/i);
  return match ? Number(match[1]) : null;
}

function parseDateToDay(value) {
  if (!value) return null;

  // Formato dd/mm/yyyy
  const str = String(value).trim();
  const match = str.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
  if (match) {
    const day = Number(match[1]);
    return Number.isFinite(day) ? day : null;
  }

  // Fallback si Google devuelve fecha serial o ISO
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return d.getDate();

  return null;
}

/* ================= FINANCIAL ENGINE (DETALLE GRAL) ================= */

function buildFinancialSummaryFromDetalle(rawDetalle, question) {
  if (!rawDetalle || rawDetalle.length < 3) {
    return { error: 'No hay datos en Detalle gral - Publi 1.' };
  }

  const dayRequested = extractDayOfMonth(question);

  // Datos diarios comienzan en fila 3 => index 2
  const dataRows = rawDetalle.slice(2);
  const rowsWithDate = dataRows.filter(r => r[0]);

  let filtered = rowsWithDate;

  if (dayRequested) {
    filtered = rowsWithDate.filter(r => {
      const day = parseDateToDay(r[0]) || parseNumber(String(r[0]).replace(/[^\d]/g, ''));
      return day === dayRequested;
    });
  }

  const targetRow = filtered[filtered.length - 1];

  if (!targetRow) {
    return {
      error: dayRequested
        ? `No encontré datos para el día ${dayRequested}.`
        : 'No encontré una fila con fecha válida.',
    };
  }

  // Columnas exactas según tu documentación:
  // A=0, B=1, C=2, D=3, E=4, F=5, G=6, H=7, L=11, O=14, P=15, Q=16, R=17, S=18
  const fecha = targetRow[0];
  const totalA_Bajar = parseNumber(targetRow[7]);
  const bajadas = parseNumber(targetRow[11]);
  const ingresos = parseNumber(targetRow[14]);
  const egresos = parseNumber(targetRow[15]);
  const perdidas = parseNumber(targetRow[16]);
  const gastos = parseNumber(targetRow[17]);
  const diferencia = parseNumber(targetRow[18]);

  const porMarca = {
    ARGENTUM: parseNumber(targetRow[2]),
    'ROYAL JYG': parseNumber(targetRow[3]),
    'TRIBET BUFFA': parseNumber(targetRow[4]),
    TIGER: parseNumber(targetRow[5]),
    MARSHALL: parseNumber(targetRow[6]),
  };

  let faltante_bajar = 0;
  let sobrante = 0;

  if (diferencia < 0) faltante_bajar = Math.abs(diferencia);
  if (diferencia > 0) sobrante = diferencia;

  return {
    fecha,
    resumen_global: {
      total_a_bajar: totalA_Bajar,
      bajadas,
      ingresos,
      egresos,
      perdidas,
      gastos,
      diferencia,
      faltante_bajar,
      sobrante,
    },
    por_marca: porMarca,
  };
}

function detectChanges(prev, curr) {
  if (!prev || prev.error || curr.error) return [];
  const alerts = [];

  if (prev.resumen_global.diferencia !== curr.resumen_global.diferencia) {
    alerts.push(
      `Diferencia cambió de ${prev.resumen_global.diferencia} a ${curr.resumen_global.diferencia}`
    );
  }

  return alerts;
}

/* ================= CACHE REFRESH ================= */

async function refreshCache(questionForContext = '') {
  const { rawData } = await loadAllSheets();
  const detalle = rawData['Detalle gral - Publi 1'];
  const summary = buildFinancialSummaryFromDetalle(detalle, questionForContext);
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
1) Analizar el cierre diario del casino.
2) Detectar faltantes, sobrantes y riesgos.
3) Responder con precisión numérica y claridad.
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
