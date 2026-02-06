require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const OpenAI = require('openai');

const app = express();
app.use(express.json());

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

// Memoria por chat (RAM)
const chatMemory = new Map();
const MAX_HISTORY = 12; // 12 mensajes (6 user + 6 assistant)

// Precios GPT-4o-mini (USD por 1M tokens)
const PRICE_INPUT_PER_1M = 0.15;
const PRICE_OUTPUT_PER_1M = 0.60;

// Límite de costo por mensaje (USD)
const MAX_COST_USD = 0.5;

// Máximo de tokens de salida para controlar gasto
const MAX_OUTPUT_TOKENS = 800;

// Cálculo de tokens máximos de entrada según presupuesto
const MAX_INPUT_TOKENS = Math.floor(
  (MAX_COST_USD - (MAX_OUTPUT_TOKENS * PRICE_OUTPUT_PER_1M) / 1_000_000) /
    (PRICE_INPUT_PER_1M / 1_000_000)
);

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

  const headers = values[headerRowIndex - 1].map((h) => (h || '').trim());
  const dataRows = values.slice(headerRowIndex);

  return dataRows.map((row) => {
    const obj = {};
    headers.forEach((header, i) => {
      if (!header) return;
      obj[header] = row[i] ?? '';
    });
    return obj;
  });
}

async function loadAllSheets() {
  const allData = {};

  for (const sheet of SHEETS_CONFIG) {
    const values = await getSheetValues(sheet.name, sheet.range);
    const rows = rowsToObjects(values, sheet.headerRow);
    allData[sheet.name] = rows;
  }

  return allData;
}

function getChatHistory(chatId) {
  if (!chatMemory.has(chatId)) chatMemory.set(chatId, []);
  return chatMemory.get(chatId);
}

function pushHistory(chatId, role, content) {
  const history = getChatHistory(chatId);
  history.push({ role, content });

  // Recortar historial si excede MAX_HISTORY
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
}

function sanitizeTelegramText(text) {
  return text.replace(/[*#]/g, '');
}

async function askChatGPT(chatId, question) {
  const data = await loadAllSheets();

  const payload = JSON.stringify(data);
  const approxTokens = Math.ceil(payload.length / 4);

  if (approxTokens > MAX_INPUT_TOKENS) {
    return `⚠️ Datos muy grandes (${payload.length} chars ~ ${approxTokens} tokens). No consulté a OpenAI.`;
  }

  const systemPrompt = `
Sos un analista financiero y operativo. Tenés acceso completo a 8 hojas de Google Sheets.

Tu tarea SIEMPRE es:
1) Hacer un resumen general del estado global usando las formulas de las hojas.
2) Responder la pregunta específica del usuario usando TODOS los datos.
3) Detallar observaciones relevantes de la hoja MOVIMIENTOS dentro del cierre, de forma simple.

Reglas del cierre:
- El cierre debe seguir las formulas reales del Sheet.
- Bajadas es la plata que hay en CBU.
- Pedí comprobantes que sumen exactamente el monto de la celda de bajadas.
- Si hay pendiente, aclarar que se baja durante el dia o el proximo dia y se anota en la celda de pendiente al cierre.

Además, tenés memoria de la conversación y debés mantener contexto.

Estilo:
- No uses * ni #.
- No uses markdown.
- Usá emojis para separar ideas y dar claridad.

Si faltan datos, explicá qué falta.
Si hay números, calculá y explicá.

Hojas:
- Detalle gral - Publi 1
- MOVIMIENTOS
- ARGENTUM
- ROYAL JYG
- TRIBET BUFFA
- TIGER
- MARSHALL
- TOTAL USDT
`;

  const history = getChatHistory(chatId);

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.2,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: `Datos completos:\n${payload}\n\nPregunta: ${question}` },
    ],
  });

  return sanitizeTelegramText(response.choices[0].message.content || '');
}

// Responde a cualquier mensaje de texto (sin comandos)
bot.on('message', async (msg) => {
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
    bot.sendMessage(chatId, 'Error al consultar datos. Revisá logs.');
  }
});

/* ================= WEBHOOK ================= */

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

app.get('/', (req, res) => res.send('Bot activo'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server listo'));
