const admin = require('firebase-admin');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const FAQ_COLLECTION = process.env.AI_FAQ_COLLECTION || 'ai_faqs';
const MIN_FAQ_SCORE = Number(process.env.AI_FAQ_MIN_SCORE || 12);

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function initFirebaseAdmin() {
  if (admin.apps.length > 0) return admin;

  const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  const serviceAccountKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

  if (serviceAccountBase64) {
    const serviceAccount = JSON.parse(
      Buffer.from(serviceAccountBase64, 'base64').toString('utf8')
    );

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    return admin;
  }

  if (serviceAccountKey) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(serviceAccountKey)),
    });

    return admin;
  }

  // Jika backend sudah berjalan di environment Google/Firebase, ini tetap bisa aktif.
  admin.initializeApp();
  return admin;
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch (_) {
      return {};
    }
  }

  return req.body;
}

function cleanText(value, fallback = '') {
  const text = String(value ?? fallback).trim();
  return text || fallback;
}

function normalizeText(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u00C0-\u024F\u1E00-\u1EFF\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .filter((item) => item && typeof item.content === 'string')
    .slice(-8)
    .map((item) => ({
      role: item.role === 'assistant' ? 'assistant' : 'user',
      content: cleanText(item.content).slice(0, 900),
    }));
}

function isMontirPediaAllowedQuestion(message) {
  const text = normalizeText(message);
  if (!text) return false;

  const allowedKeywords = [
    // Aplikasi dan layanan MontirPedia
    'montirpedia',
    'montir pedia',
    'home service',
    'booking',
    'jadwal',
    'jemput',
    'antar',
    'bengkel',
    'mekanik',
    'montir',
    'sparepart',
    'suku cadang',
    'status order',
    'status pesanan',
    'pesanan',
    'order',
    'pembayaran',
    'midtrans',
    'nota',
    'akun',
    'login',
    'daftar',
    'customer service',
    'cs',
    'chat mekanik',

    // Kendaraan dan servis
    'motor',
    'mobil',
    'kendaraan',
    'servis',
    'service',
    'perbaikan',
    'rusak',
    'mogok',
    'mesin',
    'oli',
    'aki',
    'ban',
    'rem',
    'kampas',
    'kopling',
    'rantai',
    'busi',
    'karburator',
    'injeksi',
    'radiator',
    'overheat',
    'lampu',
    'kelistrikan',
    'starter',
    'knalpot',
    'tune up',
    'ac',
    'transmisi',
    'suspensi',
    'shock',
    'bearing',
    'velg',
    'balancing',
    'spooring',
    'filter',
    'sensor',
    'ecu',
    'scan',
    'diagnosa',
    'diagnosis',
    'bensin',
    'solar',
    'bbm',
    'asap',
    'bunyi',
    'getar',
    'bocor',
    'panas',
    'mati',
    'nyala',
    'tarikan',
    'brebet',
    'ngelitik',
    'selip',
  ];

  return allowedKeywords.some((keyword) => text.includes(keyword));
}

function outOfScopeReply() {
  return [
    'Maaf, Chat AI MontirPedia hanya bisa membantu pertanyaan seputar layanan MontirPedia, servis/perbaikan kendaraan, sparepart, booking, Home Service, Jemput Antar, status order, pembayaran, akun, CS, mekanik, dan pertolongan awal kendaraan.',
    '',
    'Silakan tulis pertanyaan yang berhubungan dengan kendaraan atau layanan MontirPedia, misalnya:',
    '- Motor saya susah distarter, harus cek apa dulu?',
    '- Bagaimana cara booking servis?',
    '- Bagaimana cek status Home Service?',
    '- Apakah sparepart dibayar lewat aplikasi?',
  ].join('\n');
}

function defaultFaqs() {
  return [
    {
      question: 'Apa itu Home Service?',
      category: 'home service',
      keywords: ['home service', 'montir datang', 'servis di rumah'],
      answer:
        'Home Service adalah layanan MontirPedia untuk membantu customer melakukan servis ringan di lokasi customer. Jika kerusakan berat, customer akan diarahkan ke layanan Jemput Antar atau bengkel.',
    },
    {
      question: 'Bagaimana cara booking servis?',
      category: 'booking',
      keywords: ['booking', 'booking jadwal', 'jadwal servis', 'servis bengkel'],
      answer:
        'Untuk booking servis, buka menu Booking Jadwal, pilih bengkel, pilih tanggal dan jam, isi data kendaraan serta keluhan, lalu kirim booking. Bengkel akan mengonfirmasi jadwalnya.',
    },
    {
      question: 'Bagaimana cara cek status order?',
      category: 'status',
      keywords: ['status', 'status order', 'status pesanan', 'cek pesanan'],
      answer:
        'Status order bisa dilihat melalui menu Status. Di sana customer dapat memantau Home Service, Booking Jadwal, Jemput Antar, dan pembelian sparepart.',
    },
    {
      question: 'Bagaimana pembayaran sparepart?',
      category: 'sparepart',
      keywords: ['sparepart', 'suku cadang', 'bayar sparepart'],
      answer:
        'Untuk layanan Home Service, biaya jasa layanan dibayar melalui aplikasi setelah servis selesai. Biaya sparepart dapat dibayar langsung kepada montir sesuai kesepakatan dan bukti pembelian.',
    },
    {
      question: 'Apa yang harus dilakukan jika motor mogok?',
      category: 'pertolongan awal',
      keywords: ['motor mogok', 'mogok', 'susah hidup', 'tidak bisa distarter'],
      answer:
        'Jika motor mogok, cek bahan bakar, posisi standar samping, saklar engine cut-off, kondisi aki, dan suara starter. Jika ada bau bensin, asap tebal, kabel terbakar, atau mesin sangat panas, jangan dipaksa jalan dan hubungi mekanik/CS.',
    },
  ];
}

function calculateFaqScore({ userQuestion, faq }) {
  const question = normalizeText(faq.question || '');
  const answer = cleanText(faq.answer || '');
  const category = normalizeText(faq.category || '');
  const keywords = Array.isArray(faq.keywords) ? faq.keywords : [];

  if (!answer) return 0;

  let score = 0;

  if (question && userQuestion === question) score += 20;
  if (question && userQuestion.includes(question)) score += 12;

  for (const rawKeyword of keywords) {
    const keyword = normalizeText(rawKeyword);
    if (!keyword) continue;

    if (userQuestion === keyword) score += 16;
    else if (userQuestion.includes(keyword)) score += 9;

    const parts = keyword.split(' ');
    for (const part of parts) {
      if (part.length > 3 && userQuestion.includes(part)) score += 2;
    }
  }

  if (category && userQuestion.includes(category)) score += 6;

  const questionWords = question.split(' ');
  for (const word of questionWords) {
    if (word.length > 3 && userQuestion.includes(word)) score += 2;
  }

  return score;
}

async function loadFaqsFromFirestore() {
  try {
    const firebaseAdmin = initFirebaseAdmin();
    const db = firebaseAdmin.firestore();

    const snapshot = await db
      .collection(FAQ_COLLECTION)
      .where('isActive', '==', true)
      .limit(80)
      .get();

    if (snapshot.empty) return defaultFaqs();

    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...(doc.data() || {}),
    }));
  } catch (error) {
    console.error('Gagal membaca ai_faqs:', error.message);
    return defaultFaqs();
  }
}

async function findAnswerFromDatabase(message) {
  const userQuestion = normalizeText(message);
  const faqs = await loadFaqsFromFirestore();

  let bestFaq = null;
  let bestScore = 0;

  for (const faq of faqs) {
    const score = calculateFaqScore({ userQuestion, faq });

    if (score > bestScore) {
      bestScore = score;
      bestFaq = faq;
    }
  }

  if (!bestFaq || bestScore < MIN_FAQ_SCORE) {
    return null;
  }

  return {
    reply: cleanText(bestFaq.answer),
    provider: 'firestore',
    model: FAQ_COLLECTION,
    score: bestScore,
    source: {
      type: 'database',
      collection: FAQ_COLLECTION,
      id: bestFaq.id || '',
      category: bestFaq.category || '',
    },
  };
}

function buildSystemInstruction() {
  return [
    'Kamu adalah Chat AI MontirPedia.',
    'Jawab dalam bahasa Indonesia yang singkat, jelas, ramah, dan praktis.',
    'Ruang lingkup kamu hanya: layanan MontirPedia, Home Service, Booking Jadwal, Jemput Antar, sparepart, bengkel, mekanik, status order, pembayaran layanan, akun, CS, servis/perbaikan kendaraan, dan pertolongan awal kendaraan.',
    'Jika pertanyaan di luar ruang lingkup tersebut, tolak secara sopan dan arahkan kembali ke layanan MontirPedia atau servis kendaraan.',
    'Jangan menjawab topik umum seperti politik, hiburan, tugas sekolah, coding, keuangan umum, agama, hukum, kesehatan manusia, atau topik lain yang tidak terkait layanan MontirPedia dan kendaraan.',
    'Jangan mengarang data internal aplikasi seperti status order, harga final, data bengkel, nomor admin, atau kebijakan yang tidak tersedia di prompt.',
    'Jika user bertanya status order dan data order tidak tersedia, arahkan ke menu Status atau Chat CS.',
    'Untuk keluhan kendaraan, berikan saran awal yang aman. Diagnosis final tetap perlu dicek mekanik.',
    'Jika ada tanda bahaya seperti rem blong, mesin overheat parah, asap tebal, bau bensin, kabel terbakar, atau ban pecah, sarankan berhenti berkendara dan hubungi mekanik/CS.',
    'Jangan memberi instruksi perbaikan yang berisiko tinggi atau membahayakan.',
  ].join('\n');
}

function buildGeminiPrompt({ message, history, user, appContext }) {
  const safeHistory = sanitizeHistory(history);
  const historyText = safeHistory
    .map((item) => `${item.role === 'assistant' ? 'AI' : 'User'}: ${item.content}`)
    .join('\n');

  return [
    buildSystemInstruction(),
    '',
    `Konteks aplikasi: ${JSON.stringify(appContext || {})}`,
    `Data user: ${JSON.stringify({
      uid: user && user.uid ? user.uid : '',
      name: user && user.name ? user.name : '',
      email: user && user.email ? user.email : '',
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
    .map((part) => (part && part.text ? part.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

async function askGemini({ message, history, user, appContext }) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY belum dipasang di Environment Variables Vercel.');
  }

  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${GEMINI_MODEL}:generateContent`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'x-goog-api-key': GEMINI_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: buildGeminiPrompt({
                message,
                history,
                user,
                appContext,
              }),
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.35,
        maxOutputTokens: 700,
      },
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data && data.error && data.error.message
        ? data.error.message
        : 'Gagal meminta jawaban dari Gemini.'
    );
  }

  const reply = extractGeminiText(data);

  if (!reply) {
    throw new Error('Gemini tidak mengirim teks jawaban.');
  }

  return {
    reply,
    provider: 'gemini',
    model: GEMINI_MODEL,
  };
}

module.exports = async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      error: 'Method tidak diizinkan. Gunakan POST.',
    });
  }

  try {
    const body = parseBody(req);
    const message = cleanText(body.message);
    const history = Array.isArray(body.history) ? body.history : [];
    const user = body.user || {};
    const appContext = body.appContext || {};

    if (!message) {
      return res.status(400).json({
        success: false,
        error: 'Pesan tidak boleh kosong.',
      });
    }

    if (!isMontirPediaAllowedQuestion(message)) {
      return res.status(200).json({
        success: true,
        reply: outOfScopeReply(),
        provider: 'montirpedia_scope_guard',
        model: 'database-rule',
        sources: [],
        restricted: true,
      });
    }

    const databaseAnswer = await findAnswerFromDatabase(message);

    if (databaseAnswer) {
      return res.status(200).json({
        success: true,
        reply: databaseAnswer.reply,
        provider: databaseAnswer.provider,
        model: databaseAnswer.model,
        sources: [databaseAnswer.source],
        score: databaseAnswer.score,
        fromDatabase: true,
      });
    }

    const geminiAnswer = await askGemini({
      message,
      history,
      user,
      appContext,
    });

    return res.status(200).json({
      success: true,
      reply: geminiAnswer.reply,
      provider: geminiAnswer.provider,
      model: geminiAnswer.model,
      sources: [],
      fromDatabase: false,
    });
  } catch (error) {
    console.error('ai-chat error:', error);

    return res.status(500).json({
      success: false,
      error: error && error.message ? error.message : 'Terjadi kesalahan pada AI Chat.',
    });
  }
};
