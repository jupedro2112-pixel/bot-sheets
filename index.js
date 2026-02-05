require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');

const app = express();
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);

const auth = new google.auth.GoogleAuth({
  credentials: serviceAccount,
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});

async function getSheetData(range) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range,
  });

  return res.data.values || [];
}

bot.onText(/\/resumen/, async (msg) => {
  const chatId = msg.chat.id;
  const data = await getSheetData('Detalle gral - Publi 1!A3:AB3');

  if (data.length === 0) return bot.sendMessage(chatId, 'No hay datos.');
  bot.sendMessage(chatId, `Fila: ${JSON.stringify(data[0])}`);
});

app.get('/', (req, res) => res.send('Bot activo'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server listo'));
