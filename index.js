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

const RESUMEN_SHEET = 'RESUMEN DIARIO';

const METRICS = ['VENTA', 'DEPOSITOS', 'RETIROS', 'COMISION', 'NETO'];

const cierreSessions = new Map();

const resumenMemory = new Map();
const MAX_HISTORY = 5;
const MAX_QA_ROWS = 200;

const BATCH_WINDOW_MS = 5000;
const batchQueue = new Map();

const MAX_INT_DIGITS = 12;
const MAX_VALUE = 1e12;

const GROUP_CONFIGS = {
  publicidad: {
    chatId: '-5207612016',
    sheetId: '1ehEzABG63Qdr7uqK0YY9I0OE1bhSAgHmrTqZl3kcNFA',
    cierreCommand: 'hacer cierre publicidad',
    teamOrder: [
      { key: 'ARGENTUM', label: 'ARGENTUM' },
      { key: 'IGNITE_ROYAL', label: 'IGNITE/ROYAL' },
      { key: 'IGNITE_TRIBET', label: 'IGNITE/TRIBET' },
      { key: 'TIGER', label: 'TIGER' },
      { key: 'MARSHALL', label: 'MARSHALL' },
      { key: 'ATOMIC', label: 'ATOMIC' },
    ],
  },
  ganamos: {
    chatId: '-5226617614',
    sheetId: '16IBVRk-VCS5cKdjmIes5OoeXbir357-r0WnR0dqyJGI',
    cierreCommand: 'hacer cierre ganamos',
    teamOrder: [
      { key: 'LUXOR', label: 'LUXOR' },
      { key: 'CIRCA', label: 'CIRCA' },
      { key: 'BIG', label: 'BIG' },
      { key: 'ZYRO', label: 'ZYRO' },
      { key: 'MET', label: 'MET' },
      { key: 'METAWIN', label: 'METAWIN' },
    ],
  },
};

function buildResumenColumns(teamOrder) {
  const teamColumns = teamOrder.flatMap((team) =>
    METRICS.map((metric) => `${team.key}_${metric}`)
  );
  return [
    'FECHA',
    ...teamColumns,
    'TOTAL_NETO',
    'TOTAL_A_BAJAR',
    'BAJADO_REAL',
    'PENDIENTE_A_BAJAR',
    'PRESTAMOS_PEDIDOS',
    'PRESTAMOS_DEVUELTOS',
    'PRESTAMOS_PENDIENTES',
    'GASTOS',
    'CBU_A_LAS_00_00',
    'OBSERVACIONES',
  ];
}

const CONFIG_BY_CHAT = new Map(
  Object.values(GROUP_CONFIGS).map((config) => [
    config.chatId,
    { ...config, resumenColumns: buildResumenColumns(config.teamOrder) },
  ])
);

function getConfigByChatId(chatId) {
  return CONFIG_BY_CHAT.get(String(chatId)) || null;
}

function sanitizeTelegramText(text) {
  return text.replace(/[*#]/g, '');
}

function parseNumber(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const n = raw;
    const intPart = Math.trunc(Math.abs(n)).toString();
    if (intPart.length > MAX_INT_DIGITS) return null;
    if (Math.abs(n) > MAX_VALUE) return null;
    return Math.round(n * 100) / 100;
  }

  const text = String(raw).trim();
  if (!text) return null;

  const cleaned = text.replace(/[^\d.,-]/g, '');
  if (!cleaned) return null;

  const hasComma = cleaned.includes(',');
  const hasDot = cleaned.includes('.');

  let normalized = cleaned;

  if (hasComma && hasDot) {
    normalized = cleaned.replace(/\./g, '').replace(/,/g, '.');
  } else if (hasComma) {
    const last = cleaned.lastIndexOf(',');
    const decimals = cleaned.length - last - 1;
    if (decimals === 2) {
      normalized = cleaned.replace(/\./g, '').replace(/,/g, '.');
    } else {
      normalized = cleaned.replace(/,/g, '');
    }
  } else if (hasDot) {
    const last = cleaned.lastIndexOf('.');
    const decimals = cleaned.length - last - 1;
    if (decimals === 2) {
      normalized = cleaned.replace(/,/g, '');
    } else {
      normalized = cleaned.replace(/\./g, '');
    }
  }

  const match = normalized.match(/^-?\d+(\.\d+)?$/);
  if (!match) return null;

  const intPart = match[0].split('.')[0].replace('-', '');
  if (intPart.length > MAX_INT_DIGITS) return null;

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  if (Math.abs(parsed) > MAX_VALUE) return null;

  return Math.round(parsed * 100) / 100;
}

function formatNumberES(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  return new Intl.NumberFormat('es-AR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function parseTwoNumbers(text) {
  const nums = (text.match(/-?\d[\d.,]*/g) || []).map(parseNumber).filter((n) => n !== null);
  if (nums.length < 2) return null;
  return nums.slice(0, 2);
}

function safeJsonExtract(text) {
  const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
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
    let [p1, p2, p3] = parts;

    if (p1.length === 4) return `${p3.padStart(2, '0')}/${p2.padStart(2, '0')}/${p1}`;
    if (p3.length === 4) return `${p1.padStart(2, '0')}/${p2.padStart(2, '0')}/${p3}`;
    if (p3.length === 2) return `${p1.padStart(2, '0')}/${p2.padStart(2, '0')}/20${p3}`;
  }
  return normalized;
}

function getDateCandidates(value) {
  const normalized = normalizeDateValue(value);
  if (!normalized) return [];
  const parts = normalized.split('/');
  if (parts.length !== 3) return [];

  let [p1, p2, p3] = parts;
  let year = '';

  if (p1.length === 4) year = p1;
  else if (p3.length === 4) year = p3;
  else if (p3.length === 2) year = `20${p3}`;
  else return [];

  const day = p1.length === 4 ? p3 : p1;
  const month = p2;

  const candidates = new Set();
  const cand1 = `${day.padStart(2, '0')}/${month.padStart(2, '0')}/${year}`;
  candidates.add(cand1);

  if (Number(day) <= 12 && Number(month) <= 12) {
    const cand2 = `${month.padStart(2, '0')}/${day.padStart(2, '0')}/${year}`;
    candidates.add(cand2);
  }

  return Array.from(candidates);
}

function extractDateFromText(text) {
  const iso = text.match(/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/);
  if (iso) return normalizeDateInput(iso[0]);

  const dmy = text.match(/\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/);
  if (dmy) return normalizeDateInput(dmy[0]);

  return '';
}

function normalizeIdExact(value) {
  if (!value) return '';
  return String(value).trim();
}

function extractComprobanteId(item, fallback) {
  const id =
    item.comprobante_id ||
    item.coelsa_id ||
    item.operacion_id ||
    item.id ||
    item.referencia ||
    '';
  const normalized = normalizeIdExact(id);
  if (normalized) return normalized;
  return fallback ? normalizeIdExact(fallback) : '';
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

async function getSheetValues(config, sheetName, range) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: `${sheetName}!${range}`,
  });

  return res.data.values || [];
}

async function clearResumenRow(config, rowIndex) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const lastColumnLetter = columnIndexToLetter(config.resumenColumns.length - 1);
  const range = `${RESUMEN_SHEET}!A${rowIndex}:${lastColumnLetter}${rowIndex}`;

  await sheets.spreadsheets.values.clear({
    spreadsheetId: config.sheetId,
    range,
  });
}

async function writeResumenRow(config, rowIndex, values) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  const lastColumnLetter = columnIndexToLetter(config.resumenColumns.length - 1);
  const range = `${RESUMEN_SHEET}!A${rowIndex}:${lastColumnLetter}${rowIndex}`;

  await sheets.spreadsheets.values.update({
    spreadsheetId: config.sheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [values],
    },
  });
}

async function findResumenRowByDate(config, dateStr) {
  const columnA = await getSheetValues(config, RESUMEN_SHEET, 'A:A');
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

async function getNextResumenRow(config, dateStr) {
  const existing = await findResumenRowByDate(config, dateStr);
  if (existing) return existing;

  const columnA = await getSheetValues(config, RESUMEN_SHEET, 'A:A');
  for (let i = columnA.length - 1; i >= 1; i -= 1) {
    if ((columnA[i]?.[0] || '').toString().trim() !== '') {
      return i + 2;
    }
  }
  return 2;
}

async function getPendingFromPreviousDay(config, dateStr) {
  const dates = await getSheetValues(config, RESUMEN_SHEET, 'A:A');
  const pendings = await getSheetValues(config, RESUMEN_SHEET, 'AI:AI');
  const target = normalizeDateInput(dateStr);

  let targetRow = -1;
  for (let i = 1; i < dates.length; i += 1) {
    const cellValue = dates[i]?.[0] ?? '';
    if (normalizeDateInput(cellValue) === target) {
      targetRow = i;
      break;
    }
  }

  if (targetRow > 1) {
    const prev = pendings[targetRow - 1]?.[0];
    return parseNumber(prev) ?? 0;
  }

  for (let i = pendings.length - 1; i >= 1; i -= 1) {
    const val = parseNumber(pendings[i]?.[0]);
    if (val !== null) return val;
  }

  return 0;
}

async function analyzeSingleImage(imageUrl, caption = '') {
  const systemPrompt = `
Extraé datos financieros de UNA SOLA imagen.
Respondé SOLO JSON:
{"type":"panel","depositos_texto":"","retiros_texto":"","fecha_texto":""}
o
{"type":"bajado","monto_texto":"","fecha_texto":"","comprobante_id":"","coelsa_id":"","operacion_id":""}
o
{"type":"cbu","monto_texto":""}
o
{"type":"none"}

Reglas:
- Si falta un dato, dejalo vacío ("").
- Si hay más de un monto, devolvé el monto total transferido.
- Para CBU devolvé el saldo total visible en la cuenta.
`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    max_tokens: 300,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Contexto: ${caption || 'sin texto'}` },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      },
    ],
  });

  const raw = response.choices[0].message.content || '';
  const parsed = safeJsonExtract(raw);
  if (!parsed || !parsed.type) return null;
  return parsed;
}

async function analyzeImages(imageUrls, caption = '') {
  if (!imageUrls.length) return null;

  const panelDatesRaw = [];
  const bajadoItemsDetailed = [];
  const panelItems = [];
  const cbuItems = [];
  let bajadoInvalidCount = 0;
  let cbuInvalidCount = 0;

  for (const imageUrl of imageUrls) {
    const item = await analyzeSingleImage(imageUrl, caption);
    if (!item || item.type === 'none') continue;

    if (item.type === 'panel') {
      const fechaRaw = item.fecha_texto || '';
      if (fechaRaw) panelDatesRaw.push(fechaRaw);

      const dep = parseNumber(item.depositos_texto);
      const ret = parseNumber(item.retiros_texto);
      if (dep !== null || ret !== null) {
        panelItems.push({ depositos: dep ?? 0, retiros: ret ?? 0 });
      }
    } else if (item.type === 'bajado') {
      const fechaRaw = item.fecha_texto || '';
      const monto = parseNumber(item.monto_texto);
      const idFallback = `${fechaRaw}|${item.monto_texto || ''}`;
      const id = extractComprobanteId(item, idFallback);

      if (monto !== null && fechaRaw) {
        bajadoItemsDetailed.push({ amount: monto, fechaRaw, id });
      } else {
        bajadoInvalidCount += 1;
      }
    } else if (item.type === 'cbu') {
      const monto = parseNumber(item.monto_texto);
      if (monto !== null) {
        cbuItems.push(monto);
      } else {
        cbuInvalidCount += 1;
      }
    }
  }

  let panelData = null;
  if (panelItems.length > 0) {
    const panelDeposit = panelItems.reduce((sum, p) => sum + p.depositos, 0);
    const panelRetiros = panelItems.reduce((sum, p) => sum + p.retiros, 0);
    const ventaFinal = panelDeposit - panelRetiros;
    panelData = { venta: ventaFinal, depositos: panelDeposit, retiros: panelRetiros };
  }

  const cbuTotal = cbuItems.length ? cbuItems.reduce((sum, v) => sum + v, 0) : null;

  return {
    panel: panelData,
    panelDatesRaw,
    bajadoItemsDetailed,
    bajadoInvalidCount,
    cbuTotal,
    cbuInvalidCount,
  };
}

function buildResumenValues(config, summary) {
  const values = [];
  const push = (val) => values.push(val ?? '');

  push(summary.fecha);

  config.teamOrder.forEach((team) => {
    const t = summary.teams[team.key];
    push(formatNumberES(t.venta));
    push(formatNumberES(t.depositos));
    push(formatNumberES(t.retiros));
    push(formatNumberES(t.comision));
    push(formatNumberES(t.neto));
  });

  push(formatNumberES(summary.totalNeto));
  push(formatNumberES(summary.totalABajar));
  push(formatNumberES(summary.bajadoReal));
  push(formatNumberES(summary.pendienteABajar));
  push(formatNumberES(summary.prestamosPedidos));
  push(formatNumberES(summary.prestamosDevueltos));
  push(formatNumberES(summary.prestamosPendientes));
  push(formatNumberES(summary.gastos));
  push(formatNumberES(summary.cbu00));
  push(summary.observaciones);

  return values;
}

function summarizeCierre(config, summary) {
  const lines = [];
  lines.push(`📅 Fecha: ${summary.fecha}`);
  lines.push(`📌 Pendiente anterior: ${formatNumberES(summary.pendienteAnterior)}`);
  config.teamOrder.forEach((team) => {
    const t = summary.teams[team.key];
    lines.push(
      `🎯 ${team.label}: Venta ${formatNumberES(t.venta)} | Depósitos ${formatNumberES(t.depositos)} | Retiros ${formatNumberES(t.retiros)} | Comisión ${formatNumberES(t.comision)} | Neto ${formatNumberES(t.neto)}`
    );
  });
  lines.push(`💸 Gastos: ${formatNumberES(summary.gastos)}`);
  lines.push(`💰 Total Neto: ${formatNumberES(summary.totalNeto)}`);
  lines.push(`🏦 Total a Bajar: ${formatNumberES(summary.totalABajar)}`);
  lines.push(`✅ Bajado Real: ${formatNumberES(summary.bajadoReal)}`);
  lines.push(`⚠️ Pendiente a Bajar: ${formatNumberES(summary.pendienteABajar)}`);
  lines.push(`ℹ️ CBU 00:00: ${formatNumberES(summary.cbu00)}`);
  lines.push(`🤝 Préstamos Pedidos: ${formatNumberES(summary.prestamosPedidos)}`);
  lines.push(`🤝 Préstamos Devueltos: ${formatNumberES(summary.prestamosDevueltos)}`);
  lines.push(`📌 Préstamos Pendientes: ${formatNumberES(summary.prestamosPendientes)}`);
  if (summary.alertas.length) {
    lines.push(`🚨 Alertas:`);
    summary.alertas.forEach((a) => lines.push(`- ${a}`));
  }
  if (summary.observaciones) lines.push(`📝 Observaciones: ${summary.observaciones}`);
  return lines.join('\n');
}

function promptStep(config, chatId, session) {
  if (session.step === 'fecha') {
    bot.sendMessage(chatId, sanitizeTelegramText('📅 Pasame la fecha (dd/mm/aaaa o yyyy-mm-dd).'));
    return;
  }
  if (session.step === 'equipo') {
    const team = config.teamOrder[session.teamIndex];
    bot.sendMessage(
      chatId,
      sanitizeTelegramText(
        `🎯 ${team.label}: enviame Depósitos y Retiros (o foto del panel). La venta se calcula como Depósitos - Retiros.`
      )
    );
    return;
  }
  if (session.step === 'prestamos') {
    bot.sendMessage(
      chatId,
      sanitizeTelegramText('🤝 Préstamos: enviá pedidos y devueltos. Ej: 9000000, 3000000')
    );
    return;
  }
  if (session.step === 'gastos') {
    bot.sendMessage(chatId, sanitizeTelegramText('💸 Gastos del día (sin devolución).'));
    return;
  }
  if (session.step === 'bajado') {
    bot.sendMessage(chatId, sanitizeTelegramText('🏦 ¿Cuánto se bajó real hoy? Podés mandar comprobantes.'));
    return;
  }
  if (session.step === 'cbu') {
    bot.sendMessage(
      chatId,
      sanitizeTelegramText('ℹ️ ¿Cuánto hay en CBU a las 00:00? Podés mandar fotos de bancos.')
    );
    return;
  }
  if (session.step === 'observaciones') {
    bot.sendMessage(chatId, sanitizeTelegramText('📝 Observaciones del día (o "sin obs").'));
    return;
  }
  if (session.step === 'confirmar') {
    bot.sendMessage(chatId, sanitizeTelegramText('¿Está todo correcto? (si/no)'));
  }
}

function goBack(config, chatId, session) {
  session.pendingSummary = null;

  if (session.step === 'confirmar') {
    session.step = 'observaciones';
    session.observaciones = '';
    promptStep(config, chatId, session);
    return true;
  }

  if (session.step === 'observaciones') {
    session.step = 'cbu';
    promptStep(config, chatId, session);
    return true;
  }

  if (session.step === 'cbu') {
    session.step = 'bajado';
    promptStep(config, chatId, session);
    return true;
  }

  if (session.step === 'bajado') {
    session.step = 'gastos';
    promptStep(config, chatId, session);
    return true;
  }

  if (session.step === 'gastos') {
    session.step = 'prestamos';
    promptStep(config, chatId, session);
    return true;
  }

  if (session.step === 'prestamos') {
    session.step = 'equipo';
    session.teamIndex = config.teamOrder.length - 1;
    const team = config.teamOrder[session.teamIndex];
    delete session.teams[team.key];
    promptStep(config, chatId, session);
    return true;
  }

  if (session.step === 'equipo') {
    if (session.teamIndex > 0) {
      session.teamIndex -= 1;
      const team = config.teamOrder[session.teamIndex];
      delete session.teams[team.key];
      promptStep(config, chatId, session);
      return true;
    }
    session.step = 'fecha';
    session.fecha = '';
    promptStep(config, chatId, session);
    return true;
  }

  bot.sendMessage(chatId, sanitizeTelegramText('⚠️ No hay un paso anterior.'));
  return true;
}

function startCierre(config, chatId) {
  cierreSessions.set(chatId, {
    step: 'fecha',
    teamIndex: 0,
    fecha: '',
    teams: {},
    prestamosPedidos: 0,
    prestamosDevueltos: 0,
    bajadoReal: 0,
    gastos: 0,
    cbu00: null,
    observaciones: '',
    seenComprobanteIds: new Set(),
    pendingSummary: null,
    config,
  });
  promptStep(config, chatId, cierreSessions.get(chatId));
}

async function handleDeleteFecha(config, chatId, text) {
  if (!/borrar fecha/i.test(text)) return false;
  const date = extractDateFromText(text);
  if (!date) {
    bot.sendMessage(chatId, sanitizeTelegramText('📅 Pasame la fecha a borrar (dd/mm/aaaa).'));
    return true;
  }
  const rowIndex = await findResumenRowByDate(config, date);
  if (!rowIndex) {
    bot.sendMessage(chatId, sanitizeTelegramText('⚠️ No encontré esa fecha en RESUMEN DIARIO.'));
    return true;
  }
  await clearResumenRow(config, rowIndex);
  bot.sendMessage(
    chatId,
    sanitizeTelegramText(`✅ Fecha ${date} borrada de RESUMEN DIARIO (fila ${rowIndex}).`)
  );
  return true;
}

async function getResumenData(config) {
  const lastColumnLetter = columnIndexToLetter(config.resumenColumns.length - 1);
  const rows = await getSheetValues(config, RESUMEN_SHEET, `A:${lastColumnLetter}`);
  if (!rows.length) return [];

  const header = rows[0].map((h) => h?.toString().trim() || '');
  const dataRows = rows.slice(1);
  const indexMap = config.resumenColumns.map((col) => header.indexOf(col));

  return dataRows
    .filter((row) => row && row.length)
    .map((row) => {
      const record = {};
      config.resumenColumns.forEach((col, idx) => {
        const pos = indexMap[idx];
        record[col] = pos >= 0 ? row[pos] ?? '' : '';
      });
      return record;
    });
}

function getResumenHistory(chatId) {
  return resumenMemory.get(chatId) || [];
}

function addResumenHistory(chatId, role, content) {
  const history = resumenMemory.get(chatId) || [];
  history.push({ role, content });
  const trimmed = history.slice(-MAX_HISTORY);
  resumenMemory.set(chatId, trimmed);
}

async function interpretResumenQuestion(config, question, history) {
  const systemPrompt = `
Sos un parser de preguntas sobre "RESUMEN DIARIO".
Devolvé SOLO JSON con este formato:
{
  "action": "sum" | "value" | "avg" | "list",
  "columns": ["COLUMNA1", "COLUMNA2"],
  "date": "dd/mm/aaaa" | "",
  "date_from": "dd/mm/aaaa" | "",
  "date_to": "dd/mm/aaaa" | ""
}
`;

  const allowedColumns = config.resumenColumns.join(', ');
  const historyText = history.map((m) => `${m.role}: ${m.content}`).join('\n');

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    max_tokens: 200,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Columnas válidas: ${allowedColumns}\nHistorial:\n${historyText}\nPregunta: ${question}`,
      },
    ],
  });

  const raw = response.choices[0].message.content || '';
  const parsed = safeJsonExtract(raw);
  if (!parsed || !parsed.action || !Array.isArray(parsed.columns)) return null;
  return parsed;
}

async function formatResumenResponse(question, resultText, history) {
  const systemPrompt = `
Sos un asistente de atención sobre RESUMEN DIARIO.
Respondé en español, formal, serio y muy breve (máx. 3 líneas).
Usá 0 a 2 emojis. No inventes datos.
Si falta información, pedí aclaración.
`;

  const historyText = history.map((m) => `${m.role}: ${m.content}`).join('\n');

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.2,
    max_tokens: 120,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Historial:\n${historyText}\nPregunta: ${question}\nResultado calculado:\n${resultText}`,
      },
    ],
  });

  return response.choices[0].message.content?.trim() || resultText;
}

async function answerResumenWithLLM(question, data, history) {
  const systemPrompt = `
Sos un asistente que responde preguntas SOLO usando la hoja "RESUMEN DIARIO".
Respondé formal, serio y breve (máx. 3 líneas).
Si no hay datos suficientes, decilo con claridad.
No inventes datos.
`;

  const historyText = history.map((m) => `${m.role}: ${m.content}`).join('\n');
  const dataSlice = data.slice(-MAX_QA_ROWS);
  const dataJson = JSON.stringify(dataSlice);

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.2,
    max_tokens: 180,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Historial:\n${historyText}\nDatos:\n${dataJson}\nPregunta: ${question}`,
      },
    ],
  });

  return response.choices[0].message.content?.trim() || 'No hay datos disponibles.';
}

function dateInRange(dateStr, from, to) {
  if (!dateStr) return false;
  if (!from && !to) return true;
  const toKey = (d) => {
    const [dd, mm, yyyy] = d.split('/');
    return `${yyyy}${mm}${dd}`;
  };
  const target = toKey(dateStr);
  if (from && target < toKey(from)) return false;
  if (to && target > toKey(to)) return false;
  return true;
}

function emojiForColumn(col) {
  if (col.includes('VENTA')) return '💵';
  if (col.includes('DEPOSITOS')) return '🏦';
  if (col.includes('RETIROS')) return '💸';
  if (col.includes('COMISION')) return '🧾';
  if (col.includes('NETO')) return '✅';
  if (col.includes('GASTOS')) return '🧯';
  if (col.includes('PRESTAMOS')) return '���';
  if (col.includes('BAJADO')) return '⬇️';
  return '📌';
}

function formatResumenLine(col, value) {
  return `${emojiForColumn(col)} ${col}: ${formatNumberES(value)}`;
}

function buildQueryResult(action, columns, rows) {
  if (!rows.length) return '⚠️ No hay datos para ese criterio.';

  if (action === 'list') {
    const lines = rows.map((row) => {
      const parts = columns.map((col) => {
        const val = parseNumber(row[col]) ?? 0;
        return formatResumenLine(col, val);
      });
      return `📅 ${row.FECHA} | ${parts.join(' | ')}`;
    });
    return lines.join('\n');
  }

  const totals = {};
  columns.forEach((col) => {
    totals[col] = rows.reduce((sum, row) => sum + (parseNumber(row[col]) ?? 0), 0);
  });

  if (action === 'avg') {
    const lines = columns.map((col) => {
      const avg = totals[col] / rows.length;
      return `📊 ${col}: ${formatNumberES(avg)}`;
    });
    return lines.join('\n');
  }

  if (action === 'value' && rows.length === 1 && columns.length === 1) {
    const value = parseNumber(rows[0][columns[0]]) ?? 0;
    return `📌 ${columns[0]} (${rows[0].FECHA}): ${formatNumberES(value)}`;
  }

  const lines = columns.map((col) => formatResumenLine(col, totals[col]));
  return `📊 Resumen:\n${lines.join('\n')}`;
}

function isHelpQuestion(text) {
  return /ayuda|comandos|cómo|como|instrucciones|cerrar día|cerrar dia/i.test(text);
}

function helpMessage(config) {
  return [
    '🧭 Comandos disponibles:',
    `• "${config.cierreCommand}" → inicia cierre diario`,
    '• "volver" / "atrás" → vuelve al paso anterior',
    '• "cancelar cierre" → cancela el cierre',
    '• "borrar fecha DD/MM/AAAA" → borra esa fecha del RESUMEN',
  ].join('\n');
}

async function handleResumenQuery(config, chatId, text) {
  const question = text.trim();
  if (!question) return false;

  const data = await getResumenData(config);
  if (!data.length) {
    bot.sendMessage(chatId, sanitizeTelegramText('⚠️ No hay datos en RESUMEN DIARIO.'));
    return true;
  }

  const history = getResumenHistory(chatId);
  const parsed = await interpretResumenQuestion(config, question, history);

  if (!parsed) {
    const fallback = await answerResumenWithLLM(question, data, history);
    bot.sendMessage(chatId, sanitizeTelegramText(fallback));
    addResumenHistory(chatId, 'user', question);
    addResumenHistory(chatId, 'assistant', fallback);
    return true;
  }

  const date = normalizeDateInput(parsed.date || '');
  const dateFrom = normalizeDateInput(parsed.date_from || '');
  const dateTo = normalizeDateInput(parsed.date_to || '');
  const columns = parsed.columns.filter((c) => config.resumenColumns.includes(c));

  if (!columns.length) {
    const fallback = await answerResumenWithLLM(question, data, history);
    bot.sendMessage(chatId, sanitizeTelegramText(fallback));
    addResumenHistory(chatId, 'user', question);
    addResumenHistory(chatId, 'assistant', fallback);
    return true;
  }

  const rows = data.filter((row) => {
    const fecha = normalizeDateInput(row.FECHA || '');
    if (!fecha) return false;
    if (date && fecha !== date) return false;
    return dateInRange(fecha, dateFrom, dateTo);
  });

  const rawAnswer = buildQueryResult(parsed.action, columns, rows);
  const finalAnswer = await formatResumenResponse(question, rawAnswer, history);

  bot.sendMessage(chatId, sanitizeTelegramText(finalAnswer));
  addResumenHistory(chatId, 'user', question);
  addResumenHistory(chatId, 'assistant', finalAnswer);
  return true;
}

async function handleCierreFlow(chatId, text) {
  const session = cierreSessions.get(chatId);
  if (!session) return false;
  const config = session.config;

  if (/cancelar cierre/i.test(text)) {
    cierreSessions.delete(chatId);
    bot.sendMessage(chatId, sanitizeTelegramText('❌ Cierre cancelado.'));
    return true;
  }

  if (/^(volver|atr[aá]s)$/i.test(text)) {
    return goBack(config, chatId, session);
  }

  if (session.step === 'fecha') {
    const date = extractDateFromText(text);
    if (!date) {
      bot.sendMessage(chatId, sanitizeTelegramText('⚠️ Necesito la fecha en formato dd/mm/aaaa.'));
      return true;
    }
    session.fecha = date;
    session.step = 'equipo';
    promptStep(config, chatId, session);
    return true;
  }

  if (session.step === 'equipo') {
    const numbers = parseTwoNumbers(text);
    if (!numbers) {
      bot.sendMessage(chatId, sanitizeTelegramText('⚠️ Formato inválido. Enviá 2 números: depósitos, retiros.'));
      return true;
    }
    const [depositos, retiros] = numbers;
    const venta = Math.round(depositos - retiros);
    const comision = Math.round(depositos * 0.015);
    const neto = Math.round(venta - comision);

    const team = config.teamOrder[session.teamIndex];
    session.teams[team.key] = { venta, depositos, retiros, comision, neto };

    session.teamIndex += 1;
    if (session.teamIndex < config.teamOrder.length) {
      promptStep(config, chatId, session);
      return true;
    }

    session.step = 'prestamos';
    promptStep(config, chatId, session);
    return true;
  }

  if (session.step === 'prestamos') {
    const numbers = parseTwoNumbers(text);
    if (!numbers) {
      bot.sendMessage(chatId, sanitizeTelegramText('⚠️ Formato inválido. Enviá 2 números: pedidos, devueltos.'));
      return true;
    }
    session.prestamosPedidos = numbers[0];
    session.prestamosDevueltos = numbers[1];
    session.step = 'gastos';
    promptStep(config, chatId, session);
    return true;
  }

  if (session.step === 'gastos') {
    const gastos = parseNumber(text);
    if (gastos === null) {
      bot.sendMessage(chatId, sanitizeTelegramText('⚠️ Enviá un número válido para gastos.'));
      return true;
    }
    session.gastos = gastos;
    session.step = 'bajado';
    promptStep(config, chatId, session);
    return true;
  }

  if (session.step === 'bajado') {
    const bajado = parseNumber(text);
    if (bajado === null) {
      bot.sendMessage(chatId, sanitizeTelegramText('⚠️ Enviá un número válido para bajado real.'));
      return true;
    }
    session.bajadoReal = bajado;
    session.step = 'cbu';
    promptStep(config, chatId, session);
    return true;
  }

  if (session.step === 'cbu') {
    const cbu = parseNumber(text);
    if (cbu === null) {
      bot.sendMessage(chatId, sanitizeTelegramText('⚠️ Enviá un número válido para CBU 00:00.'));
      return true;
    }
    session.cbu00 = cbu;
    session.step = 'observaciones';
    promptStep(config, chatId, session);
    return true;
  }

  if (session.step === 'observaciones') {
    session.observaciones = text.trim() || 'sin obs';

    const totalNetoRaw = config.teamOrder.reduce(
      (sum, team) => sum + session.teams[team.key].neto,
      0
    );
    const totalNeto = Math.round(totalNetoRaw - session.gastos);
    const pendienteAnterior = await getPendingFromPreviousDay(config, session.fecha);
    const totalABajar = Math.round(totalNeto + pendienteAnterior);
    const pendienteABajar = Math.round(totalABajar - session.bajadoReal);
    const prestamosPendientes = Math.round(session.prestamosPedidos - session.prestamosDevueltos);

    const alertas = [];
    if (pendienteABajar > 0) alertas.push('Falta bajar dinero respecto al total.');
    if (pendienteABajar < 0) alertas.push('Se bajó más dinero del total a bajar.');
    if (prestamosPendientes !== 0) alertas.push('Hay préstamos pendientes de devolución.');
    if (totalNeto < 0) alertas.push('Total neto negativo: revisar balances por equipo.');

    const minTeam = config.teamOrder.reduce((min, team) => {
      const t = session.teams[team.key];
      if (!min || t.neto < min.neto) return { key: team.label, neto: t.neto };
      return min;
    }, null);

    if (minTeam && minTeam.neto < 0) {
      alertas.push(`Revisar equipo con neto más negativo: ${minTeam.key} (${minTeam.neto}).`);
    }

    session.pendingSummary = {
      fecha: session.fecha,
      teams: session.teams,
      totalNeto,
      totalABajar,
      bajadoReal: session.bajadoReal,
      pendienteABajar,
      prestamosPedidos: session.prestamosPedidos,
      prestamosDevueltos: session.prestamosDevueltos,
      prestamosPendientes,
      gastos: session.gastos,
      observaciones: session.observaciones,
      alertas,
      pendienteAnterior,
      cbu00: session.cbu00,
    };

    const resumenTexto = summarizeCierre(config, session.pendingSummary);
    bot.sendMessage(
      chatId,
      sanitizeTelegramText(`${resumenTexto}\n\n¿Está todo correcto? (si/no)`)
    );
    session.step = 'confirmar';
    return true;
  }

  if (session.step === 'confirmar') {
    if (/^si$/i.test(text)) {
      const summary = session.pendingSummary;
      const rowIndex = await getNextResumenRow(config, summary.fecha);
      const rowValues = buildResumenValues(config, summary);
      await writeResumenRow(config, rowIndex, rowValues);

      bot.sendMessage(
        chatId,
        sanitizeTelegramText(`✅ Cierre guardado en RESUMEN DIARIO (fila ${rowIndex}).`)
      );
      cierreSessions.delete(chatId);
      return true;
    }

    if (/^no$/i.test(text)) {
      cierreSessions.delete(chatId);
      bot.sendMessage(chatId, sanitizeTelegramText('❌ Cierre descartado. Empezamos de nuevo.'));
      startCierre(config, chatId);
      return true;
    }

    bot.sendMessage(chatId, sanitizeTelegramText('Respondé con "si" o "no".'));
    return true;
  }

  return false;
}

function validateBajadoItems(items, cierreFecha, seenSet) {
  let total = 0;
  const duplicates = [];

  for (const item of items) {
    if (!item.fechaRaw) {
      return { error: 'missing_date' };
    }
    const candidates = getDateCandidates(item.fechaRaw);
    if (!candidates.includes(cierreFecha)) {
      return { error: 'date_mismatch' };
    }

    if (item.id) {
      if (seenSet.has(item.id)) {
        duplicates.push(item.id);
        continue;
      }
      seenSet.add(item.id);
    }

    total += item.amount;
  }

  return { total, duplicates };
}

function panelDatesMatch(panelDatesRaw, cierreFecha) {
  if (!panelDatesRaw.length) return true;
  return panelDatesRaw.some((raw) => getDateCandidates(raw).includes(cierreFecha));
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
  const config = getConfigByChatId(chatId);
  if (!config) {
    return;
  }

  const batch = batchQueue.get(chatId);
  if (!batch) return;

  batchQueue.delete(chatId);

  const combinedText = batch.texts.join('\n').trim();
  const imageUrls = batch.images;

  const deleteHandled = await handleDeleteFecha(config, chatId, combinedText);
  if (deleteHandled) return;

  const session = cierreSessions.get(chatId);

  if (combinedText.toLowerCase() === config.cierreCommand && !session) {
    startCierre(config, chatId);
    return;
  }

  if (!session) {
    if (isHelpQuestion(combinedText)) {
      bot.sendMessage(chatId, sanitizeTelegramText(helpMessage(config)));
      return;
    }
    const answered = await handleResumenQuery(config, chatId, combinedText);
    if (answered) return;
  }

  let text = combinedText.replace(new RegExp(config.cierreCommand, 'i'), '').trim();

  let imageData = null;
  if (imageUrls.length) {
    imageData = await analyzeImages(imageUrls, text);
  }

  if (session && imageData) {
    if (session.step === 'cbu') {
      if (imageData.cbuInvalidCount > 0) {
        await bot.sendMessage(
          chatId,
          sanitizeTelegramText('⚠️ No pude leer el saldo CBU en una o más fotos.')
        );
        return;
      }
      if (imageData.cbuTotal !== null) {
        await bot.sendMessage(
          chatId,
          sanitizeTelegramText(`ℹ️ Total CBU 00:00 (suma bancos): ${formatNumberES(imageData.cbuTotal)}`)
        );
        text = `${imageData.cbuTotal}`;
      }
    }

    if (session.step === 'equipo' && imageData.panel) {
      await bot.sendMessage(
        chatId,
        sanitizeTelegramText(
          `📌 Panel detectado: Depósitos ${formatNumberES(imageData.panel.depositos)} | Retiros ${formatNumberES(imageData.panel.retiros)} | Venta ${formatNumberES(imageData.panel.venta)}`
        )
      );
      text = `${imageData.panel.depositos}, ${imageData.panel.retiros}`;
    }

    if (session.step === 'bajado' && imageData.bajadoItemsDetailed.length > 0) {
      const result = validateBajadoItems(
        imageData.bajadoItemsDetailed,
        session.fecha,
        session.seenComprobanteIds
      );
      if (result.error === 'missing_date') {
        await bot.sendMessage(
          chatId,
          sanitizeTelegramText('⚠️ No se encontró la fecha en uno o más comprobantes.')
        );
        return;
      }
      if (result.error === 'date_mismatch') {
        await bot.sendMessage(
          chatId,
          sanitizeTelegramText(
            `⚠️ La fecha de los comprobantes no coincide con el cierre (${session.fecha}).`
          )
        );
        return;
      }
      await bot.sendMessage(
        chatId,
        sanitizeTelegramText(`✅ Total comprobantes: ${formatNumberES(result.total)}`)
      );
      text = `${result.total}`;
    }

    if (!panelDatesMatch(imageData.panelDatesRaw, session.fecha)) {
      await bot.sendMessage(
        chatId,
        sanitizeTelegramText(
          `⚠️ La fecha del panel no coincide con el cierre (${session.fecha}).`
        )
      );
      return;
    }

    if (imageData.bajadoInvalidCount > 0) {
      await bot.sendMessage(
        chatId,
        sanitizeTelegramText('⚠️ No se encontró el monto en uno o más comprobantes.')
      );
      return;
    }
  }

  if (session) {
    const handled = await handleCierreFlow(chatId, text || '');
    if (handled) return;
  }
}

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  if (!text || text.startsWith('/')) return;
  enqueueBatch(chatId, { text });
});

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
