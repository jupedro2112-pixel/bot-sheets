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
  'ATOMIC_VENTA',
  'ATOMIC_DEPOSITOS',
  'ATOMIC_RETIROS',
  'ATOMIC_COMISION',
  'ATOMIC_NETO',
  'TOTAL_NETO',
  'TOTAL_A_BAJAR',
  'BAJADO_REAL',
  'PENDIENTE_A_BAJAR',
  'PRESTAMOS_PEDIDOS',
  'PRESTAMOS_DEVUELTOS',
  'PRESTAMOS_PENDIENTES',
  'GASTOS',
  'OBSERVACIONES',
];

const TEAM_ORDER = [
  { key: 'ARGENTUM', label: 'ARGENTUM' },
  { key: 'IGNITE_ROYAL', label: 'IGNITE/ROYAL' },
  { key: 'IGNITE_TRIBET', label: 'IGNITE/TRIBET' },
  { key: 'TIGER', label: 'TIGER' },
  { key: 'MARSHALL', label: 'MARSHALL' },
  { key: 'ATOMIC', label: 'ATOMIC' },
];

const cierreSessions = new Map();

const BATCH_WINDOW_MS = 5000;
const batchQueue = new Map();

const MAX_INT_DIGITS = 12;
const MAX_VALUE = 1e12;

function sanitizeTelegramText(text) {
  return text.replace(/[*#]/g, '');
}

function parseNumber(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;

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

async function getPendingFromPreviousDay(dateStr) {
  const dates = await getSheetValues(RESUMEN_SHEET, 'A:A');
  const pendings = await getSheetValues(RESUMEN_SHEET, 'AI:AI');
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
Devolvé SOLO JSON:
{"type":"panel","depositos":"","retiros":"","fecha":""}
o
{"type":"bajado","monto_texto":"","fecha":""}
o
{"type":"none"}

La fecha puede venir como "01/02/2026" o "2026-02-01".
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

  const fechasPanel = [];
  const fechasBajado = [];
  const panelItems = [];
  const bajadoItems = [];
  let bajadoInvalidCount = 0;

  for (const imageUrl of imageUrls) {
    const item = await analyzeSingleImage(imageUrl, caption);
    if (!item || item.type === 'none') continue;

    const fecha = normalizeDateInput(item.fecha || '');
    if (item.type === 'panel' && fecha) fechasPanel.push(fecha);
    if (item.type === 'bajado' && fecha) fechasBajado.push(fecha);

    if (item.type === 'panel') {
      const dep = parseNumber(item.depositos);
      const ret = parseNumber(item.retiros);
      if (dep !== null || ret !== null) {
        panelItems.push({ depositos: dep ?? 0, retiros: ret ?? 0 });
      }
    } else if (item.type === 'bajado') {
      const montoRaw = item.monto_texto || item.monto;
      const monto = parseNumber(montoRaw);
      if (monto !== null) {
        bajadoItems.push(monto);
      } else {
        bajadoInvalidCount += 1;
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

  const bajadoTotal = bajadoItems.length
    ? bajadoItems.reduce((sum, v) => sum + v, 0)
    : null;

  return {
    panel: panelData,
    bajadoTotal,
    fechasPanel,
    fechasBajado,
    bajadoItemsCount: bajadoItems.length,
    bajadoInvalidCount,
  };
}

function buildResumenValues(summary) {
  const values = [];
  const push = (val) => values.push(val ?? '');

  push(summary.fecha);

  TEAM_ORDER.forEach((team) => {
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
  push(summary.observaciones);

  return values;
}

function summarizeCierre(summary) {
  const lines = [];
  lines.push(`📅 Fecha: ${summary.fecha}`);
  lines.push(`📌 Pendiente anterior: ${formatNumberES(summary.pendienteAnterior)}`);
  TEAM_ORDER.forEach((team) => {
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

function startCierre(chatId) {
  cierreSessions.set(chatId, {
    step: 'fecha',
    teamIndex: 0,
    fecha: '',
    teams: {},
    prestamosPedidos: 0,
    prestamosDevueltos: 0,
    bajadoReal: 0,
    gastos: 0,
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
        `🎯 ${team.label}: enviame Depósitos y Retiros (o foto del panel). La venta se calcula como Depósitos - Retiros. Ej: 5000000, 4000000`
      )
    );
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

    const team = TEAM_ORDER[session.teamIndex];
    session.teams[team.key] = { venta, depositos, retiros, comision, neto };

    session.teamIndex += 1;
    if (session.teamIndex < TEAM_ORDER.length) {
      const next = TEAM_ORDER[session.teamIndex];
      bot.sendMessage(
        chatId,
        sanitizeTelegramText(
          `🎯 ${next.label}: enviame Depósitos y Retiros (o foto del panel). La venta se calcula como Depósitos - Retiros.`
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
      bot.sendMessage(chatId, sanitizeTelegramText('⚠️ Formato inválido. Enviá 2 números: pedidos, devueltos.'));
      return true;
    }
    session.prestamosPedidos = numbers[0];
    session.prestamosDevueltos = numbers[1];
    session.step = 'gastos';
    bot.sendMessage(chatId, sanitizeTelegramText('💸 Gastos del día (sin devolución).'));
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
    bot.sendMessage(chatId, sanitizeTelegramText('🏦 ¿Cuánto se bajó real hoy? Podés mandar comprobantes.'));
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

    const totalNetoRaw = TEAM_ORDER.reduce((sum, team) => sum + session.teams[team.key].neto, 0);
    const totalNeto = Math.round(totalNetoRaw - session.gastos);
    const pendienteAnterior = await getPendingFromPreviousDay(session.fecha);
    const totalABajar = Math.round(totalNeto + pendienteAnterior);
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
      gastos: session.gastos,
      observaciones: session.observaciones,
      alertas,
      pendienteAnterior,
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

  const combinedText = batch.texts.join('\n').trim();
  const imageUrls = batch.images;

  if (/hacer cierre/i.test(combinedText) && !cierreSessions.has(chatId)) {
    startCierre(chatId);
  }

  let text = combinedText.replace(/hacer cierre/i, '').trim();
  const session = cierreSessions.get(chatId);

  let imageData = null;
  if (imageUrls.length) {
    imageData = await analyzeImages(imageUrls, text);
  }

  if (session && imageData) {
    const fechasBajado = imageData.fechasBajado || [];
    if (imageData.bajadoInvalidCount > 0) {
      bot.sendMessage(
        chatId,
        sanitizeTelegramText('⚠️ No pude leer uno o más montos de comprobantes. Reenviá las fotos.')
      );
      return;
    }
    if (imageData.bajadoItemsCount > 0) {
      if (fechasBajado.length !== imageData.bajadoItemsCount) {
        bot.sendMessage(
          chatId,
          sanitizeTelegramText('⚠️ No pude leer la fecha de uno o más comprobantes. Reenviá las fotos.')
        );
        return;
      }
      const mismatch = fechasBajado.some((f) => f !== session.fecha);
      if (mismatch) {
        bot.sendMessage(
          chatId,
          sanitizeTelegramText(
            `⚠️ La fecha de los comprobantes no coincide con el cierre (${session.fecha}). Enviá solo comprobantes de ese día.`
          )
        );
        return;
      }
    }
  }

  if (session) {
    if (!text) {
      if (session.step === 'equipo' && imageData?.panel) {
        text = `${imageData.panel.depositos}, ${imageData.panel.retiros}`;
      }
      if (session.step === 'bajado' && imageData?.bajadoTotal !== null) {
        text = `${imageData.bajadoTotal}`;
      }
    }
    const handled = await handleCierreFlow(chatId, text || '');
    if (handled) return;
  }

  if (!session && combinedText) {
    bot.sendMessage(chatId, sanitizeTelegramText('Usá "hacer cierre" para iniciar el cierre diario paso a paso.'));
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
