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
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
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

const RESUMEN_SHEET = 'RESUMEN DIARIO';
const RESUMEN_COLUMNS = [
  'FECHA',
  'ARGENTUM_VENTA',
  'ARGENTUM_DEPOSITOS',
  'ARGENTUM_RETIROS',
  'ARGENTUM_COMISION',
  'ARGENTUM_NETO',
  'IGNITE_ROYAL_VENTA',
  'IGNITE_ROYAL_DEPOSITOS',
  'IGNITE_ROYAL_RETIROS',
  'IGNITE_ROYAL_COMISION',
  'IGNITE_ROYAL_NETO',
  'IGNITE_TRIBET_VENTA',
  'IGNITE_TRIBET_DEPOSITOS',
  'IGNITE_TRIBET_RETIROS',
  'IGNITE_TRIBET_COMISION',
  'IGNITE_TRIBET_NETO',
  'TIGER_VENTA',
  'TIGER_DEPOSITOS',
  'TIGER_RETIROS',
  'TIGER_COMISION',
  'TIGER_NETO',
  'MARSHALL_VENTA',
  'MARSHALL_DEPOSITOS',
  'MARSHALL_RETIROS',
  'MARSHALL_COMISION',
  'MARSHALL_NETO',
  'TOTAL_NETO',
  'TOTAL_A_BAJAR',
  'BAJADO_REAL',
  'PENDIENTE_A_BAJAR',
  'PRESTAMOS_PEDIDOS',
  'PRESTAMOS_DEVUELTOS',
  'PRESTAMOS_PENDIENTES',
  'OBSERVACIONES',
];

const TEAM_ORDER = [
  { key: 'ARGENTUM', label: 'ARGENTUM' },
  { key: 'IGNITE_ROYAL', label: 'IGNITE/ROYAL' },
  { key: 'IGNITE_TRIBET', label: 'IGNITE/TRIBET' },
  { key: 'TIGER', label: 'TIGER' },
  { key: 'MARSHALL', label: 'MARSHALL' },
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

// Límite duro de tokens
const MAX_TOTAL_TOKENS = 1_000_000;

// Cálculo de tokens máximos de entrada según presupuesto
const MAX_INPUT_TOKENS = Math.floor(
  (MAX_COST_USD - (MAX_OUTPUT_TOKENS * PRICE_OUTPUT_PER_1M) / 1_000_000) /
    (PRICE_INPUT_PER_1M / 1_000_000)
);

// Agrupador por chat
const BATCH_WINDOW_MS = 5000;
const batchQueue = new Map();

// Pendientes de escritura por confirmación
const pendingWrites = new Map();

// Sesiones de cierre
const cierreSessions = new Map();

function getSheetConfig(name) {
  return SHEETS_CONFIG.find((s) => s.name === name);
}

function makeUniqueHeaders(headers) {
  const seen = {};
  return headers.map((header) => {
    const key = (header || '').trim();
    if (!key) return '';
    if (!seen[key]) {
      seen[key] = 1;
      return key;
    }
    seen[key] += 1;
    return `${key}_${seen[key]}`;
  });
}

function estimateTokensFromText(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

function estimateTokensFromContent(content) {
  if (!content) return 0;
  if (typeof content === 'string') return estimateTokensFromText(content);

  if (Array.isArray(content)) {
    let total = 0;
    for (const item of content) {
      if (item.type === 'text') {
        total += estimateTokensFromText(item.text);
      } else if (item.type === 'image_url') {
        total += 100;
      }
    }
    return total;
  }
  return 0;
}

function logTokenCost({ status, inputTokens, outputTokens, costUsd, note }) {
  const msg =
    `[TOKENS] status=${status} input=${inputTokens} output=${outputTokens} ` +
    `cost_usd=${costUsd.toFixed(6)}${note ? ` note=${note}` : ''}`;
  console.log(msg);
}

function parseNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const cleaned = String(raw)
    .replace(/\./g, '')
    .replace(/,/g, '.')
    .replace(/[^\d.-]/g, '');
  const parsed = Number(cleaned);
  if (Number.isNaN(parsed)) return null;
  return parsed;
}

function parseThreeNumbers(text) {
  const nums = (text.match(/-?\d[\d.,]*/g) || []).map(parseNumber).filter((n) => n !== null);
  if (nums.length < 3) return null;
  return nums.slice(0, 3);
}

function parseTwoNumbers(text) {
  const nums = (text.match(/-?\d[\d.,]*/g) || []).map(parseNumber).filter((n) => n !== null);
  if (nums.length < 2) return null;
  return nums.slice(0, 2);
}

function sanitizeTelegramText(text) {
  return text.replace(/[*#]/g, '');
}

function safeJsonExtract(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function normalizeDateValue(value) {
  if (!value) return '';
  const raw = String(value).trim();
  if (!raw) return '';
  return raw
    .replace(/\./g, '/')
    .replace(/-/g, '/')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function normalizeDateInput(value) {
  const normalized = normalizeDateValue(value);
  if (!normalized) return '';

  const parts = normalized.split('/');
  if (parts.length === 3) {
    const [p1, p2, p3] = parts;
    if (p1.length === 4) return `${p3.padStart(2, '0')}/${p2.padStart(2, '0')}/${p1}`;
    if (p3.length === 4) return `${p1.padStart(2, '0')}/${p2.padStart(2, '0')}/${p3}`;
  }
  return normalized;
}

function extractDateFromText(text) {
  const iso = text.match(/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/);
  if (iso) return normalizeDateInput(iso[0]);

  const dmy = text.match(/\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/);
  if (dmy) return normalizeDateInput(dmy[0]);

  return '';
}

function columnIndexToLetter(index) {
  let num = index + 1;
  let letter = '';
  while (num > 0) {
    const mod = (num - 1) % 26;
    letter = String.fromCharCode(65 + mod) + letter;
    num = Math.floor((num - mod) / 26);
  }
  return letter;
}

async function getSheetValues(sheetName, range) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!${range}`,
  });

  return res.data.values || [];
}

async function getRowGridData(sheetName, rowNumber, headerRowIndex) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  const range = `${sheetName}!A${headerRowIndex}:Z${rowNumber}`;
  const res = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
    ranges: [range],
    includeGridData: true,
  });

  const grid = res.data.sheets?.[0]?.data?.[0];
  const rowData = grid?.rowData || [];

  const rawHeaders =
    rowData[headerRowIndex - 1]?.values?.map((cell) => cell.formattedValue || '') || [];
  const headers = makeUniqueHeaders(rawHeaders);

  const targetRow = rowData[rowNumber - headerRowIndex] || { values: [] };

  const obj = {};
  const fobj = {};

  headers.forEach((header, idx) => {
    if (!header) return;
    const cell = targetRow.values?.[idx] || {};
    const value = cell.formattedValue ?? '';
    const formula = cell.userEnteredValue?.formulaValue ?? '';
    obj[header] = value;
    fobj[header] = { value, formula };
  });

  return { row: obj, formulaRow: fobj, headers };
}

async function writeSheetValue(sheetName, cell, value) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!${cell}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[value]],
    },
  });
}

async function writeResumenRow(rowIndex, values) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  const lastColumnLetter = columnIndexToLetter(RESUMEN_COLUMNS.length - 1);
  const range = `${RESUMEN_SHEET}!A${rowIndex}:${lastColumnLetter}${rowIndex}`;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [values],
    },
  });
}

async function deleteSheetValue(sheetName, cell) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!${cell}`,
  });
}

function parseWriteRequest(text) {
  const match = text.match(/hoja:\s*(.+?)\s+celda:\s*([A-Z]+[0-9]+)\s+valor:\s*(.+)$/i);
  if (!match) return null;
  return {
    sheetName: match[1].trim(),
    cell: match[2].trim().toUpperCase(),
    value: match[3].trim(),
    source: 'texto',
    action: 'write',
  };
}

function parseDeleteRequest(text) {
  const match = text.match(/borrar\s+hoja:\s*(.+?)\s+celda:\s*([A-Z]+[0-9]+)\s*$/i);
  if (!match) return null;
  return {
    sheetName: match[1].trim(),
    cell: match[2].trim().toUpperCase(),
    source: 'texto',
    action: 'delete',
  };
}

function rowsToObjects(values, headerRowIndex) {
  if (!values.length || values.length < headerRowIndex) return [];

  const headers = makeUniqueHeaders(values[headerRowIndex - 1].map((h) => (h || '').trim()));
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

  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
}

async function findRowByDate(sheetName, dateStr) {
  const config = getSheetConfig(sheetName);
  if (!config) return null;

  const columnA = await getSheetValues(sheetName, 'A:A');
  const target = normalizeDateInput(dateStr);

  for (let i = config.headerRow; i < columnA.length; i += 1) {
    const cellValue = columnA[i]?.[0] ?? '';
    const normalized = normalizeDateInput(cellValue);
    if (normalized && normalized === target) {
      return i + 1;
    }
  }
  return null;
}

async function getDetalleRowByDate(dateStr) {
  const sheetName = 'Detalle gral - Publi 1';
  const config = getSheetConfig(sheetName);
  if (!config) return null;

  const values = await getSheetValues(sheetName, 'A:Z');
  if (!values.length || values.length < config.headerRow) return null;

  const headers = makeUniqueHeaders(values[config.headerRow - 1].map((h) => (h || '').trim()));
  const target = normalizeDateInput(dateStr);

  for (let i = config.headerRow; i < values.length; i += 1) {
    const row = values[i] || [];
    const dateCell = row[0] ?? '';
    if (normalizeDateInput(dateCell) === target) {
      const obj = {};
      headers.forEach((header, idx) => {
        if (!header) return;
        obj[header] = row[idx] ?? '';
      });
      return { rowIndex: i + 1, row: obj, headers };
    }
  }
  return null;
}

async function resolveCellByDate(sheetName, column, dateStr) {
  const row = await findRowByDate(sheetName, dateStr);
  if (!row) return null;
  return `${column}${row}`;
}

async function findResumenRowByDate(dateStr) {
  const columnA = await getSheetValues(RESUMEN_SHEET, 'A:A');
  const target = normalizeDateInput(dateStr);

  for (let i = 1; i < columnA.length; i += 1) {
    const cellValue = columnA[i]?.[0] ?? '';
    const normalized = normalizeDateInput(cellValue);
    if (normalized && normalized === target) {
      return i + 1;
    }
  }
  return null;
}

async function getNextResumenRow(dateStr) {
  const existing = await findResumenRowByDate(dateStr);
  if (existing) return existing;

  const columnA = await getSheetValues(RESUMEN_SHEET, 'A:A');
  for (let i = columnA.length - 1; i >= 1; i -= 1) {
    if ((columnA[i]?.[0] || '').toString().trim() !== '') {
      return i + 2;
    }
  }
  return 2;
}

function buildResumenValues(summary) {
  const values = [];
  const push = (val) => values.push(val ?? '');

  push(summary.fecha);

  TEAM_ORDER.forEach((team) => {
    const t = summary.teams[team.key];
    push(t.venta);
    push(t.depositos);
    push(t.retiros);
    push(t.comision);
    push(t.neto);
  });

  push(summary.totalNeto);
  push(summary.totalABajar);
  push(summary.bajadoReal);
  push(summary.pendienteABajar);
  push(summary.prestamosPedidos);
  push(summary.prestamosDevueltos);
  push(summary.prestamosPendientes);
  push(summary.observaciones);

  return values;
}

function summarizeCierre(summary) {
  const lines = [];
  lines.push(`📅 Fecha: ${summary.fecha}`);
  TEAM_ORDER.forEach((team) => {
    const t = summary.teams[team.key];
    lines.push(
      `🎯 ${team.label}: Venta ${t.venta} | Depósitos ${t.depositos} | Retiros ${t.retiros} | Comisión ${t.comision} | Neto ${t.neto}`
    );
  });
  lines.push(`💰 Total Neto: ${summary.totalNeto}`);
  lines.push(`🏦 Total a Bajar: ${summary.totalABajar}`);
  lines.push(`✅ Bajado Real: ${summary.bajadoReal}`);
  lines.push(`⚠️ Pendiente a Bajar: ${summary.pendienteABajar}`);
  lines.push(`🤝 Préstamos Pedidos: ${summary.prestamosPedidos}`);
  lines.push(`🤝 Préstamos Devueltos: ${summary.prestamosDevueltos}`);
  lines.push(`📌 Préstamos Pendientes: ${summary.prestamosPendientes}`);
  if (summary.alertas.length) {
    lines.push(`🚨 Alertas:`);
    summary.alertas.forEach((a) => lines.push(`- ${a}`));
  }
  if (summary.observaciones) lines.push(`📝 Observaciones: ${summary.observaciones}`);
  return lines.join('\n');
}

function startCierre(chatId) {
  cierreSessions.set(chatId, {
    step: 'fecha',
    teamIndex: 0,
    fecha: '',
    teams: {},
    prestamosPedidos: 0,
    prestamosDevueltos: 0,
    bajadoReal: 0,
    observaciones: '',
  });
  bot.sendMessage(
    chatId,
    sanitizeTelegramText('📅 Iniciamos cierre. Pasame la fecha (dd/mm/aaaa o yyyy-mm-dd).')
  );
}

async function handleCierreFlow(chatId, text) {
  const session = cierreSessions.get(chatId);
  if (!session) return false;

  if (/cancelar cierre/i.test(text)) {
    cierreSessions.delete(chatId);
    bot.sendMessage(chatId, sanitizeTelegramText('❌ Cierre cancelado.'));
    return true;
  }

  if (session.step === 'fecha') {
    const date = extractDateFromText(text);
    if (!date) {
      bot.sendMessage(chatId, sanitizeTelegramText('⚠️ Necesito la fecha en formato dd/mm/aaaa.'));
      return true;
    }
    session.fecha = date;
    session.step = 'equipo';
    const team = TEAM_ORDER[session.teamIndex];
    bot.sendMessage(
      chatId,
      sanitizeTelegramText(
        `🎯 ${team.label}: enviame Venta, Depósitos y Retiros. Ej: 1000000, 5000000, 2000000`
      )
    );
    return true;
  }

  if (session.step === 'equipo') {
    const numbers = parseThreeNumbers(text);
    if (!numbers) {
      bot.sendMessage(
        chatId,
        sanitizeTelegramText('⚠️ Formato inválido. Enviá 3 números: venta, depósitos, retiros.')
      );
      return true;
    }
    const [venta, depositos, retiros] = numbers;
    const comision = Math.round(depositos * 0.015);
    const neto = Math.round(venta + depositos - retiros - comision);

    const team = TEAM_ORDER[session.teamIndex];
    session.teams[team.key] = { venta, depositos, retiros, comision, neto };

    session.teamIndex += 1;
    if (session.teamIndex < TEAM_ORDER.length) {
      const next = TEAM_ORDER[session.teamIndex];
      bot.sendMessage(
        chatId,
        sanitizeTelegramText(
          `🎯 ${next.label}: enviame Venta, Depósitos y Retiros. Ej: 1000000, 5000000, 2000000`
        )
      );
      return true;
    }

    session.step = 'prestamos';
    bot.sendMessage(
      chatId,
      sanitizeTelegramText('🤝 Préstamos: enviá pedidos y devueltos. Ej: 9000000, 3000000')
    );
    return true;
  }

  if (session.step === 'prestamos') {
    const numbers = parseTwoNumbers(text);
    if (!numbers) {
      bot.sendMessage(
        chatId,
        sanitizeTelegramText('⚠️ Formato inválido. Enviá 2 números: pedidos, devueltos.')
      );
      return true;
    }
    session.prestamosPedidos = numbers[0];
    session.prestamosDevueltos = numbers[1];
    session.step = 'bajado';
    bot.sendMessage(chatId, sanitizeTelegramText('🏦 ¿Cuánto se bajó real hoy?'));
    return true;
  }

  if (session.step === 'bajado') {
    const bajado = parseNumber(text);
    if (bajado === null) {
      bot.sendMessage(chatId, sanitizeTelegramText('⚠️ Enviá un número válido para bajado real.'));
      return true;
    }
    session.bajadoReal = bajado;
    session.step = 'observaciones';
    bot.sendMessage(chatId, sanitizeTelegramText('📝 Observaciones del día (o "sin obs").'));
    return true;
  }

  if (session.step === 'observaciones') {
    session.observaciones = text.trim() || 'sin obs';

    const totalNeto = TEAM_ORDER.reduce((sum, team) => sum + session.teams[team.key].neto, 0);
    const totalABajar = totalNeto;
    const pendienteABajar = Math.round(totalABajar - session.bajadoReal);
    const prestamosPendientes = Math.round(session.prestamosPedidos - session.prestamosDevueltos);

    const alertas = [];
    if (pendienteABajar > 0) {
      alertas.push('Falta bajar dinero respecto al total.');
    }
    if (pendienteABajar < 0) {
      alertas.push('Se bajó más dinero del total a bajar.');
    }
    if (prestamosPendientes !== 0) {
      alertas.push('Hay préstamos pendientes de devolución.');
    }
    if (totalNeto < 0) {
      alertas.push('Total neto negativo: revisar balances por equipo.');
    }

    const minTeam = TEAM_ORDER.reduce((min, team) => {
      const t = session.teams[team.key];
      if (!min || t.neto < min.neto) return { key: team.label, neto: t.neto };
      return min;
    }, null);

    if (minTeam && minTeam.neto < 0) {
      alertas.push(`Revisar equipo con neto más negativo: ${minTeam.key} (${minTeam.neto}).`);
    }

    const summary = {
      fecha: session.fecha,
      teams: session.teams,
      totalNeto,
      totalABajar,
      bajadoReal: session.bajadoReal,
      pendienteABajar,
      prestamosPedidos: session.prestamosPedidos,
      prestamosDevueltos: session.prestamosDevueltos,
      prestamosPendientes,
      observaciones: session.observaciones,
      alertas,
    };

    const rowIndex = await getNextResumenRow(summary.fecha);
    const rowValues = buildResumenValues(summary);
    await writeResumenRow(rowIndex, rowValues);

    const resumenTexto = summarizeCierre(summary);
    bot.sendMessage(
      chatId,
      sanitizeTelegramText(`✅ Cierre guardado en RESUMEN DIARIO (fila ${rowIndex}).\n\n${resumenTexto}`)
    );

    cierreSessions.delete(chatId);
    return true;
  }

  return false;
}

async function askChatGPT(chatId, question, imageUrls = []) {
  const valuesData = await loadAllSheets();

  let dateContext = '';
  let dataForPrompt = valuesData;
  let formulasForPrompt = {};

  const dateFromQuestion = extractDateFromText(question);

  if (dateFromQuestion) {
    const detalleRow = await getDetalleRowByDate(dateFromQuestion);
    if (detalleRow) {
      dataForPrompt = { ...valuesData, 'Detalle gral - Publi 1': [detalleRow.row] };
      const sheetName = 'Detalle gral - Publi 1';
      const rowNumber = detalleRow.rowIndex;
      const grid = await getRowGridData(sheetName, rowNumber, getSheetConfig(sheetName).headerRow);
      formulasForPrompt = { [sheetName]: [grid.formulaRow] };
      dateContext =
        `📅 Fecha solicitada: ${dateFromQuestion}\n` +
        `✅ Fila encontrada: ${detalleRow.rowIndex}\n` +
        `✅ Usar SOLO esta fila para ese día.\n`;
    } else {
      dateContext =
        `⚠️ No encontré la fecha ${dateFromQuestion} en la columna A de Detalle gral - Publi 1.\n` +
        `Pedime otra fecha o confirmá el formato.\n`;
      dataForPrompt = { ...valuesData, 'Detalle gral - Publi 1': [] };
      formulasForPrompt = { 'Detalle gral - Publi 1': [] };
    }
  }

  const valuesPayload = JSON.stringify(dataForPrompt);
  const formulasPayload = JSON.stringify(formulasForPrompt);
  let approxTokens = Math.ceil((valuesPayload.length + formulasPayload.length) / 4);

  if (approxTokens > MAX_INPUT_TOKENS) {
    formulasForPrompt = {};
    approxTokens = Math.ceil(valuesPayload.length / 4);

    if (approxTokens > MAX_INPUT_TOKENS) {
      const estCost = (approxTokens * PRICE_INPUT_PER_1M) / 1_000_000;
      logTokenCost({
        status: 'rejected_budget',
        inputTokens: approxTokens,
        outputTokens: 0,
        costUsd: estCost,
        note: 'excede presupuesto',
      });
      return `⚠️ Datos muy grandes (${valuesPayload.length} chars ~ ${approxTokens} tokens). No consulté a OpenAI.`;
    }
  }

  const systemPrompt = `
Sos un analista financiero y operativo con conocimiento básico de finanzas y cierres de equipos.

Regla principal
- Cada cierre es por día individual.
- Si el usuario pregunta por un día específico, usá solo los datos de ese día.
- La fecha está en la columna A de "Detalle gral - Publi 1".
- No mezcles filas de fechas distintas.

Orden exacto de columnas en "Detalle gral - Publi 1":
FECHA, DEP, ARGENTUM, IGNITE/ROYAL, IGNITE/TRIBET, TIGER, MARSHALL, TOTAL A BAJAR, BANCO 1 00hs, BANCO 2 00hs, BANCO 3 00hs, BAJADAS CBU, PENDIENTE CIERRE, CIERRE COMPLETADO, INGRESO, EGRESO, PERDIDA, GASTOS, DIFERENCIA, OBS FALTANTES, OBS GASTOS, FECHA_2, OBSERVACION DEL DIA

Reglas adicionales
- Si falta un dato para cerrar correctamente, pedilo de forma clara.
- Si el usuario aporta un dato, proponé cargarlo automáticamente en la celda correspondiente.
- Podés escribir o borrar datos solo con autorización explícita del usuario.
- Tenés acceso a valores y, cuando haya, fórmulas. Explicá el porqué del número si hay fórmula.
- Si hay un faltante de dinero significativo, señalalo y sugerí en qué equipo revisar.

Estilo:
- No uses * ni #.
- No uses markdown.
- Usá emojis para separar ideas y dar claridad.

Si faltan datos, explicá qué falta.
Si hay números, calculá y explicá.
`;

  const history = getChatHistory(chatId);

  const userContent = [
    {
      type: 'text',
      text:
        `${dateContext}` +
        `Datos completos:\n${valuesPayload}\n\n` +
        `Formulas completas:\n${JSON.stringify(formulasForPrompt)}\n\n` +
        `Mensaje(s):\n${question}`,
    },
    ...imageUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
  ];

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userContent },
  ];

  const estimatedInputTokens =
    estimateTokensFromText(systemPrompt) +
    history.reduce((sum, m) => sum + estimateTokensFromContent(m.content), 0) +
    estimateTokensFromContent(userContent);

  if (estimatedInputTokens > MAX_TOTAL_TOKENS) {
    const estCost = (estimatedInputTokens * PRICE_INPUT_PER_1M) / 1_000_000;
    logTokenCost({
      status: 'rejected_hard_limit',
      inputTokens: estimatedInputTokens,
      outputTokens: 0,
      costUsd: estCost,
      note: 'supera 1M tokens',
    });
    return `⚠️ Request demasiado grande (${estimatedInputTokens} tokens estimados). No consulté a OpenAI.`;
  }

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.2,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages,
  });

  const usage = response.usage || {};
  const inputTokens = usage.prompt_tokens ?? estimatedInputTokens;
  const outputTokens = usage.completion_tokens ?? MAX_OUTPUT_TOKENS;
  const costUsd =
    (inputTokens * PRICE_INPUT_PER_1M) / 1_000_000 +
    (outputTokens * PRICE_OUTPUT_PER_1M) / 1_000_000;

  logTokenCost({
    status: 'accepted',
    inputTokens,
    outputTokens,
    costUsd,
  });

  return sanitizeTelegramText(response.choices[0].message.content || '');
}

async function detectWriteFromImages(imageUrls, caption = '') {
  if (!imageUrls.length) return null;

  const systemPrompt = `
Leé comprobantes o paneles y proponé una escritura en Google Sheets si es claro.

Reglas:
- Si podés inferir hoja y celda exacta, devolvé cell.
- Si podés inferir hoja, columna y fecha, devolvé column y date.
- La fecha del día está en columna A de "Detalle gral - Publi 1".

Devolvé SOLO JSON con este formato:
{"sheetName":"","cell":"","column":"","date":"","value":"","reason":"","action":"write"}

Si no es claro, devolvé:
{"sheetName":"","cell":"","column":"","date":"","value":"","reason":"insuficiente","action":"none"}
`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    max_tokens: 250,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Contexto adicional: ${caption || 'sin texto'}` },
          ...imageUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
        ],
      },
    ],
  });

  const raw = response.choices[0].message.content || '';
  const parsed = safeJsonExtract(raw);

  if (!parsed) return null;

  const sheetName = String(parsed.sheetName || '').trim();
  const cell = String(parsed.cell || '').trim().toUpperCase();
  const column = String(parsed.column || '').trim().toUpperCase();
  const date = String(parsed.date || '').trim();
  const value = String(parsed.value || '').trim();
  const reason = String(parsed.reason || '').trim();
  const action = String(parsed.action || 'write').trim();

  if (!sheetName || !value || action !== 'write') return null;

  return {
    sheetName,
    cell,
    column,
    date,
    value,
    source: 'imagen',
    reason,
    action: 'write',
  };
}

function enqueueBatch(chatId, item) {
  if (!batchQueue.has(chatId)) {
    batchQueue.set(chatId, { texts: [], images: [], timer: null });
  }
  const batch = batchQueue.get(chatId);
  if (item.text) batch.texts.push(item.text);
  if (item.imageUrl) batch.images.push(item.imageUrl);

  if (batch.timer) clearTimeout(batch.timer);
  batch.timer = setTimeout(() => processBatch(chatId), BATCH_WINDOW_MS);
}

async function processBatch(chatId) {
  const batch = batchQueue.get(chatId);
  if (!batch) return;

  batchQueue.delete(chatId);

  const combinedText = batch.texts.join('\n');
  const imageUrls = batch.images;

  try {
    const writeRequests = [];
    const unresolved = [];

    for (const t of batch.texts) {
      const wr = parseWriteRequest(t);
      if (wr) writeRequests.push(wr);

      const dr = parseDeleteRequest(t);
      if (dr) writeRequests.push(dr);
    }

    const imageSuggestion = await detectWriteFromImages(imageUrls, combinedText);
    if (imageSuggestion) {
      if (imageSuggestion.cell) {
        writeRequests.push({
          sheetName: imageSuggestion.sheetName,
          cell: imageSuggestion.cell,
          value: imageSuggestion.value,
          source: imageSuggestion.source,
          action: 'write',
        });
      } else if (imageSuggestion.column && imageSuggestion.date) {
        const resolvedCell = await resolveCellByDate(
          imageSuggestion.sheetName,
          imageSuggestion.column,
          imageSuggestion.date
        );
        if (resolvedCell) {
          writeRequests.push({
            sheetName: imageSuggestion.sheetName,
            cell: resolvedCell,
            value: imageSuggestion.value,
            source: imageSuggestion.source,
            action: 'write',
          });
        } else {
          unresolved.push(
            `📅 No encontré la fecha ${imageSuggestion.date} en columna A de ${imageSuggestion.sheetName}`
          );
        }
      } else if (imageSuggestion.reason && imageSuggestion.reason !== 'insuficiente') {
        unresolved.push(`⚠️ No pude ubicar celda: ${imageSuggestion.reason}`);
      }
    }

    let confirmationBlock = '';
    if (writeRequests.length > 0) {
      pendingWrites.set(chatId, writeRequests);

      const details = writeRequests
        .map((w, i) => {
          const actionText = w.action === 'delete' ? 'BORRAR' : 'CARGAR';
          const valueText = w.action === 'delete' ? 'vaciar' : w.value;
          return `• ${i + 1}) ${actionText} Hoja ${w.sheetName} Celda ${w.cell} Valor ${valueText} (${w.source})`;
        })
        .join('\n');

      confirmationBlock =
        `📝 Detecté ${writeRequests.length} acción(es) para Sheets.\n` +
        `${details}\n` +
        `✅ Respondé "confirmar" para ejecutar o "cancelar" para no hacer cambios.\n\n`;
    }

    const unresolvedBlock = unresolved.length ? `${unresolved.join('\n')}\n\n` : '';

    if (!combinedText && imageUrls.length === 0 && !confirmationBlock) return;

    const answer = await askChatGPT(chatId, combinedText || 'Analizá comprobantes', imageUrls);

    const finalAnswer = sanitizeTelegramText(`${confirmationBlock}${unresolvedBlock}${answer}`);
    pushHistory(chatId, 'user', combinedText || '[imagenes]');
    pushHistory(chatId, 'assistant', finalAnswer);

    bot.sendMessage(chatId, finalAnswer);
  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, 'Error al procesar el lote. Revisá logs.');
  }
}

async function handleConfirmation(chatId, text) {
  const pending = pendingWrites.get(chatId);
  if (!pending || pending.length === 0) return false;

  const lower = text.toLowerCase();
  if (['confirmar', 'si', 'sí', 'ok', 'dale'].includes(lower)) {
    for (const wr of pending) {
      if (wr.action === 'delete') {
        await deleteSheetValue(wr.sheetName, wr.cell);
      } else {
        await writeSheetValue(wr.sheetName, wr.cell, wr.value);
      }
    }
    pendingWrites.delete(chatId);
    bot.sendMessage(chatId, sanitizeTelegramText('✅ Listo. Cambios aplicados en Sheets 📌'));
    return true;
  }

  if (['cancelar', 'no', 'stop'].includes(lower)) {
    pendingWrites.delete(chatId);
    bot.sendMessage(chatId, sanitizeTelegramText('❌ Cancelado. No hice cambios.'));
    return true;
  }

  return false;
}

// Responde a cualquier mensaje de texto (sin comandos)
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  if (!text || text.startsWith('/')) return;

  if (/hacer cierre/i.test(text)) {
    startCierre(chatId);
    return;
  }

  const cierreHandled = await handleCierreFlow(chatId, text);
  if (cierreHandled) return;

  try {
    const handled = await handleConfirmation(chatId, text);
    if (handled) return;

    enqueueBatch(chatId, { text });
  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, 'Error al procesar. Revisá logs.');
  }
});

// Recibe fotos y las interpreta con OpenAI
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const caption = (msg.caption || '').trim();

  try {
    const photos = msg.photo || [];
    if (!photos.length) return;

    const fileId = photos[photos.length - 1].file_id;
    const file = await bot.getFile(fileId);
    const imageUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${file.file_path}`;

    enqueueBatch(chatId, { text: caption, imageUrl });
  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, 'Error al recibir la imagen. Revisá logs.');
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
