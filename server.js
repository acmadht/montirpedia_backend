import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const PORT = process.env.PORT || 3000;
const AI_MODEL = process.env.AI_MODEL || 'gpt-4.1-mini';

function cleanText(value, fallback = '') {
  if (value === null || value === undefined) return fallback;

  const text = value.toString().trim();

  return text.length > 0 ? text : fallback;
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .slice(-12)
    .map((item) => {
      const role = item?.role === 'assistant' ? 'assistant' : 'user';
      const content = cleanText(item?.content);

      if (!content) return null;

      return {
        role,
        content,
      };
    })
    .filter(Boolean);
}

function buildSystemPrompt({ user, appContext }) {
  const userName = cleanText(user?.name, 'Pengguna');
  const userEmail = cleanText(user?.email, '-');

  const appName = cleanText(appContext?.appName, 'Montir Pedia');

  const features = Array.isArray(appContext?.features)
    ? appContext.features.join(', ')
    : 'Booking Jadwal, Home Service, Jemput Antar, Bengkel Terdekat, Status Servis, Status Booking, Status Jemput Antar, Akun, Chat Mekanik, Chat CS';

  return `
Kamu adalah AI Montir Pedia.

Identitas:
- Nama aplikasi: ${appName}
- Nama pengguna: ${userName}
- Email pengguna: ${userEmail}

Fitur aplikasi:
${features}

Tugas utama:
1. Bantu pengguna memahami fitur Montir Pedia.
2. Bantu pengguna memilih layanan yang cocok.
3. Bantu pengguna memahami masalah kendaraan secara umum.
4. Beri saran awal yang aman, praktis, dan mudah dipahami.
5. Arahkan pengguna ke layanan aplikasi jika masalah butuh pemeriksaan langsung.

Aturan jawaban:
- Gunakan bahasa Indonesia yang jelas dan singkat.
- Jawab seperti asisten Montir Pedia yang ramah.
- Jangan mengaku sebagai mekanik sungguhan.
- Jangan memberi kepastian diagnosis jika hanya berdasarkan chat.
- Jangan memberi instruksi berbahaya.
- Jika masalah terkait rem, mesin mati total, bau terbakar, kebocoran bahan bakar, atau risiko keselamatan, sarankan pengguna tidak memaksa kendaraan dipakai.
- Jika pertanyaan tentang aplikasi, jelaskan sesuai fitur Montir Pedia.
`.trim();
}

function buildInputMessages({ systemPrompt, history, message }) {
  const messages = [];

  messages.push({
    role: 'system',
    content: systemPrompt,
  });

  for (const item of history) {
    messages.push({
      role: item.role,
      content: item.content,
    });
  }

  messages.push({
    role: 'user',
    content: message,
  });

  return messages;
}

function extractReply(response) {
  if (response.output_text && response.output_text.trim().length > 0) {
    return response.output_text.trim();
  }

  const output = response.output || [];

  for (const item of output) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      const texts = item.content
        .map((contentItem) => contentItem.text || '')
        .filter(Boolean);

      if (texts.length > 0) {
        return texts.join('\n').trim();
      }
    }
  }

  return '';
}

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    app: 'Montir Pedia AI Backend',
    endpoint: '/api/ai-chat',
  });
});

app.post('/api/ai-chat', async (req, res) => {
  try {
    const message = cleanText(req.body?.message);
    const history = normalizeHistory(req.body?.history);
    const user = req.body?.user || {};
    const appContext = req.body?.appContext || {};

    if (!message) {
      return res.status(400).json({
        error: 'Pesan tidak boleh kosong.',
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        error: 'OPENAI_API_KEY belum dipasang di backend.',
      });
    }

    const systemPrompt = buildSystemPrompt({
      user,
      appContext,
    });

    const input = buildInputMessages({
      systemPrompt,
      history,
      message,
    });

    const response = await client.responses.create({
      model: AI_MODEL,
      input,
      temperature: 0.4,
      max_output_tokens: 700,
    });

    const reply = extractReply(response);

    if (!reply) {
      return res.status(500).json({
        error: 'AI tidak mengirim jawaban.',
      });
    }

    return res.json({
      reply,
      model: AI_MODEL,
    });
  } catch (error) {
    console.error('AI backend error:', error);

    return res.status(500).json({
      error: error?.message || 'Terjadi kesalahan pada backend AI.',
    });
  }
});

app.listen(PORT, () => {
  console.log(`Montir Pedia AI backend jalan di http://localhost:${PORT}`);
});