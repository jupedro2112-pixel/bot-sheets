require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const OpenAI = require('openai');

const app = express();
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
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

async function askChatGPT(question) {
  const data = await loadAllSheets();

  const systemPrompt = `
Sos un analista financiero. Tenés acceso completo a 8 hojas de Google Sheets.
Respondé preguntas con claridad, con cálculos y conclusiones si aplica.
Si faltan datos, explicá qué falta.

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

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.2,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Datos completos:\n${JSON.stringify(data)}\n\nPregunta: ${question}` },
    ],
  });

  return response.choices[0].message.content;
}

// Comando: /pregunta lo que quieras
bot.onText(/\/pregunta (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const question = match[1];

  try {
    const answer = await askChatGPT(question);
    bot.sendMessage(chatId, answer);
  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, 'Error al consultar datos. Revisá logs.');
  }
});

// Comando de prueba rápida
bot.onText(/\/resumen/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Escribí /pregunta y tu consulta. Ej: /pregunta Resumen general de hoy');
});

app.get('/', (req, res) => res.send('Bot activo'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server listo'));
