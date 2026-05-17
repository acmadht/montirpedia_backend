require('dotenv').config();

const express = require('express');
const cors = require('cors');

const sendServiceNotificationHandler = require('./api/send-service-notification');
const sendOrderStatusNotificationHandler = require('./api/send-order-status-notification');
const createMidtransTransactionHandler = require('./api/create-midtrans-transaction');
const midtransNotificationHandler = require('./api/midtrans-notification');

let sendPushNotificationHandler = null;
let sendAssignedMechanicHandler = null;

try {
  sendPushNotificationHandler = require('./api/send-push-notification');
} catch (_) {
  sendPushNotificationHandler = null;
}

try {
  sendAssignedMechanicHandler = require('./api/notify-assigned-mechanic');
} catch (_) {
  sendAssignedMechanicHandler = null;
}

const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const AI_PROVIDER = String(process.env.AI_PROVIDER || 'gemini').toLowerCase();
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

function cleanText(value, fallback = '') {
  if (value === null || value === undefined) return fallback;

  const text = value.toString().trim();

  return text.length > 0 ? text : fallback;
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .filter((item) => {
      return (
        item &&
        typeof item.content === 'string' &&
        item.content.trim().length > 0
      );
    })
    .slice(-10)
    .map((item) => {
      return {
        role: item.role === 'assistant' ? 'assistant' : 'user',
        content: item.content.slice(0, 1200),
      };
    });
}

function buildSystemInstruction() {
  return [
    'Kamu adalah AI customer assistant untuk aplikasi Montirpedia.',
    'Jawab dalam bahasa Indonesia yang singkat, jelas, ramah, dan nyambung dengan konteks chat.',
    'Bantu user untuk fitur Booking Jadwal, Home Service, Jemput Antar, Bengkel Terdekat, Status Order, Akun, Pembayaran, Chat Mekanik, dan Chat CS.',
    'Jangan mengarang data internal aplikasi seperti status order, harga final, data bengkel, nomor admin, atau kebijakan yang tidak tersedia di prompt.',
    'Jika user bertanya status order, arahkan user ke menu Status atau CS jika data order tidak tersedia.',
    'Jika user bertanya lokasi bengkel, jelaskan bahwa daftar bengkel terdekat dihitung dari GPS dan data bengkel aktif di admin master.',
    'Untuk keluhan kendaraan, berikan saran awal yang aman dan jelaskan bahwa diagnosis final tetap perlu dicek mekanik.',
    'Jika ada tanda bahaya seperti rem blong, mesin overheat parah, asap tebal, bau bensin, kabel terbakar, atau ban pecah, sarankan berhenti berkendara dan hubungi mekanik atau CS.',
    'Jangan beri instruksi berbahaya untuk perbaikan kendaraan yang berisiko tinggi.',
    'Jangan menyebut API key, token, environment variable, atau detail backend kepada user akhir.',
    'Jika tidak yakin, katakan tidak yakin dan arahkan user ke CS atau mekanik.',
  ].join('\n');
}

function buildGeminiPrompt({ message, history, user, appContext }) {
  const safeHistory = sanitizeHistory(history);

  const historyText = safeHistory
    .map((item) => {
      const speaker = item.role === 'assistant' ? 'AI' : 'User';
      return `${speaker}: ${item.content}`;
    })
    .join('\n');

  return [
    buildSystemInstruction(),
    '',
    `Konteks aplikasi: ${JSON.stringify(appContext || {})}`,
    `Data user: ${JSON.stringify({
      name: user && user.name ? user.name : '',
      email: user && user.email ? user.email : '',
      uid: user && user.uid ? user.uid : '',
    })}`,
    '',
    'Riwayat percakapan:',
    historyText || '-',
    '',
    `Pertanyaan user sekarang: ${message}`,
  ].join('\n');
}

function extractGeminiText(data) {
  const parts =
    data &&
    data.candidates &&
    data.candidates[0] &&
    data.candidates[0].content &&
    data.candidates[0].content.parts
      ? data.candidates[0].content.parts
      : [];

  return parts
    .map((part) => {
      return part && part.text ? part.text : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function isExampleGeminiKey(apiKey) {
  if (!apiKey) return true;

  return (
    apiKey.includes('ISI_KUNCI') ||
    apiKey.includes('ISI_API_KEY') ||
    apiKey.includes('GEMINI_KAMU') ||
    apiKey.includes('PASTE_KEY')
  );
}

function buildGeminiEndpoint(model) {
  return (
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${model}:generateContent`
  );
}

function buildGeminiPayload({ message, history, user, appContext }) {
  const prompt = buildGeminiPrompt({
    message,
    history,
    user,
    appContext,
  });

  return {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: prompt,
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.35,
      maxOutputTokens: 900,
    },
  };
}

function uniqueModels(models) {
  const clean = [];

  for (const model of models) {
    if (!model) continue;
    if (clean.includes(model)) continue;

    clean.push(model);
  }

  return clean;
}

async function callGeminiModel({ apiKey, model, payload }) {
  const endpoint = buildGeminiEndpoint(model);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();

  if (!response.ok) {
    const message =
      data && data.error && data.error.message
        ? data.error.message
        : 'Gagal meminta jawaban dari Gemini.';

    const error = new Error(message);
    error.status = response.status;
    error.model = model;
    throw error;
  }

  const reply = extractGeminiText(data);

  if (!reply) {
    const error = new Error('Gemini tidak mengirim teks jawaban.');
    error.status = 500;
    error.model = model;
    throw error;
  }

  return {
    reply,
    provider: 'gemini',
    model,
  };
}

async function askGemini({ message, history, user, appContext }) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY belum dipasang di file .env.');
  }

  if (isExampleGeminiKey(apiKey)) {
    throw new Error(
      'GEMINI_API_KEY masih memakai contoh. Ganti dengan kunci API Gemini asli.'
    );
  }

  const payload = buildGeminiPayload({
    message,
    history,
    user,
    appContext,
  });

  const modelsToTry = uniqueModels([
    GEMINI_MODEL,
    'gemini-2.0-flash',
    'gemini-1.5-flash',
  ]);

  let lastError = null;

  for (const model of modelsToTry) {
    try {
      return await callGeminiModel({
        apiKey,
        model,
        payload,
      });
    } catch (error) {
      lastError = error;

      console.error(
        `Gemini model ${model} gagal:`,
        error && error.message ? error.message : error
      );
    }
  }

  throw lastError || new Error('Semua model Gemini gagal dipakai.');
}

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    app: 'Montirpedia Backend',
    services: [
      'AI Chat',
      'FCM Push Notification',
      'Home Service Notification',
      'Order Status Notification',
      'Midtrans Payment',
    ],
    aiEndpoint: '/api/ai-chat',
    healthEndpoint: '/api/health',
    envCheck: '/api/env-check',
    testAi: '/api/test-ai',
    aiProvider: AI_PROVIDER,
    geminiModel: GEMINI_MODEL,
  });
});

app.get('/api/health', (req, res) => {
  return res.status(200).json({
    success: true,
    message: 'Montirpedia backend aktif.',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/env-check', (req, res) => {
  res.json({
    status: 'env-check',
    aiProvider: process.env.AI_PROVIDER || '',
    geminiModel: process.env.GEMINI_MODEL || '',
    hasGeminiKey: !!process.env.GEMINI_API_KEY,
    geminiKeyPrefix: process.env.GEMINI_API_KEY
      ? process.env.GEMINI_API_KEY.substring(0, 8)
      : 'KOSONG',
    hasFirebaseServiceAccountBase64: !!process.env.FIREBASE_SERVICE_ACCOUNT_BASE64,
    hasFirebaseServiceAccountKey: !!process.env.FIREBASE_SERVICE_ACCOUNT_KEY,
    hasMidtransServerKey: !!process.env.MIDTRANS_SERVER_KEY,
    hasMidtransClientKey: !!process.env.MIDTRANS_CLIENT_KEY,
    midtransIsProduction: process.env.MIDTRANS_IS_PRODUCTION || 'false',
  });
});

app.get('/api/test-ai', async (req, res) => {
  try {
    const result = await askGemini({
      message: 'Motor saya susah hidup, harus bagaimana?',
      history: [],
      user: {
        name: 'Hylmi',
      },
      appContext: {
        appName: 'Montirpedia',
        features: ['Booking Jadwal', 'Home Service', 'Jemput Antar'],
      },
    });

    return res.status(200).json({
      success: true,
      reply: result.reply,
      provider: result.provider,
      model: result.model,
    });
  } catch (error) {
    console.error('Test AI error message:', error && error.message);
    console.error('Test AI error full:', error);

    return res.status(500).json({
      success: false,
      error:
        error && error.message
          ? error.message
          : 'AI gagal menjawab.',
      model: error && error.model ? error.model : GEMINI_MODEL,
      status: error && error.status ? error.status : 500,
    });
  }
});

app.post('/api/ai-chat', async (req, res) => {
  try {
    console.log('AI endpoint dipanggil');

    const body = req.body || {};

    const message = cleanText(body.message);
    const history = Array.isArray(body.history) ? body.history : [];
    const user = body.user || {};
    const appContext = body.appContext || {};

    console.log('Pesan user:', message);
    console.log('Provider:', AI_PROVIDER);
    console.log('Gemini model:', GEMINI_MODEL);
    console.log(
      'Gemini key prefix:',
      process.env.GEMINI_API_KEY
        ? process.env.GEMINI_API_KEY.substring(0, 8)
        : 'KOSONG'
    );

    if (!message) {
      return res.status(400).json({
        success: false,
        error: 'Pesan tidak boleh kosong.',
      });
    }

    const result = await askGemini({
      message,
      history,
      user,
      appContext,
    });

    return res.status(200).json({
      success: true,
      reply: result.reply,
      provider: result.provider,
      model: result.model,
    });
  } catch (error) {
    console.error('AI chat error message:', error && error.message);
    console.error('AI chat error full:', error);

    return res.status(500).json({
      success: false,
      error:
        error && error.message
          ? error.message
          : 'Terjadi kesalahan pada backend AI.',
      model: error && error.model ? error.model : GEMINI_MODEL,
      status: error && error.status ? error.status : 500,
    });
  }
});

app.all('/api/send-service-notification', sendServiceNotificationHandler);
app.all('/api/send-order-status-notification', sendOrderStatusNotificationHandler);
app.all('/api/create-midtrans-transaction', createMidtransTransactionHandler);
app.all('/api/midtrans-notification', midtransNotificationHandler);

if (sendPushNotificationHandler) {
  app.all('/api/send-push-notification', sendPushNotificationHandler);
}

if (sendAssignedMechanicHandler) {
  app.all('/api/notify-assigned-mechanic', sendAssignedMechanicHandler);
}

app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return res.status(400).json({
      success: false,
      error: 'Format JSON tidak valid.',
      detail: error.message,
    });
  }

  console.error('SERVER ERROR:', error);

  return res.status(500).json({
    success: false,
    error: error && error.message ? error.message : 'Server error.',
  });
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint tidak ditemukan.',
    path: req.originalUrl,
  });
});

module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Montirpedia backend berjalan di http://localhost:${PORT}`);
  });
}
