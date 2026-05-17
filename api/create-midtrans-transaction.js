const {
  admin,
  getDb,
  verifyFirebaseTokenFromRequest,
} = require('../lib/firebaseAdmin');

const SNAP_TRANSACTION_TARGET = '/snap/v1/transactions';

function getFetch() {
  if (typeof fetch === 'function') {
    return fetch;
  }

  if (typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function') {
    return globalThis.fetch.bind(globalThis);
  }

  try {
    const nodeFetch = require('node-fetch');
    return typeof nodeFetch === 'function' ? nodeFetch : nodeFetch?.default || null;
  } catch (_) {
    return null;
  }
}

const ALLOWED_COLLECTIONS = new Set([
  'pickup_delivery_requests',
  'service_requests',
  'booking_requests',
  'booking_jadwal',
  'sparepart_orders',
  'orders',
]);

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, Accept'
  );
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res, statusCode, payload) {
  setCors(res);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  if (req.body && typeof req.body === 'object') {
    return req.body;
  }

  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch (_) {
      return {};
    }
  }

  return {};
}

function isProduction() {
  // Untuk versi pengembangan/lomba ini pembayaran dipaksa Sandbox.
  // Jangan memakai Production dari aplikasi sampai benar-benar siap rilis.
  return false;
}

function getMidtransConfig() {
  const serverKey = String(process.env.MIDTRANS_SERVER_KEY || '').trim();

  if (!serverKey) {
    throw new Error('MIDTRANS_SERVER_KEY belum diatur di environment backend.');
  }

  if (!serverKey.startsWith('SB-Mid-server-')) {
    throw new Error(
      'Backend masih memakai MIDTRANS_SERVER_KEY Production. Untuk Sandbox wajib gunakan Server Key yang diawali SB-Mid-server-.'
    );
  }

  return {
    serverKey,
    isProduction: false,
    snapBaseUrl: 'https://app.sandbox.midtrans.com',
    environment: 'sandbox',
  };
}

function isMidtransProductionUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    const host = parsed.hostname.toLowerCase();

    return (
      host.includes('midtrans.com') &&
      !host.includes('sandbox') &&
      !host.includes('localhost')
    );
  } catch (_) {
    return false;
  }
}

function isMidtransSandboxUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    const host = parsed.hostname.toLowerCase();

    return (
      host.includes('sandbox.midtrans.com') ||
      host.includes('app.sandbox.midtrans.com') ||
      host.includes('api.sandbox.midtrans.com') ||
      host.includes('localhost') ||
      host.includes('127.0.0.1')
    );
  } catch (_) {
    return false;
  }
}

function createMidtransHeaders() {
  const { serverKey } = getMidtransConfig();

  const authString = Buffer.from(`${serverKey}:`).toString('base64');

  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Basic ${authString}`,
  };
}

function toIntAmount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value);
  }

  if (typeof value === 'string') {
    const cleaned = value.replace(/[^\d]/g, '');
    const parsed = Number(cleaned);

    return Number.isFinite(parsed) ? Math.round(parsed) : 0;
  }

  return 0;
}

function safeCollectionName(value) {
  const collection = String(value || 'pickup_delivery_requests').trim();

  if (ALLOWED_COLLECTIONS.has(collection)) {
    return collection;
  }

  return 'pickup_delivery_requests';
}

function sanitizeText(value, fallback = '-') {
  const text = String(value || '').trim();

  if (!text) return fallback;

  return text
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 255);
}

function sanitizeOrderId(value) {
  return String(value || '')
    .replace(/[^A-Za-z0-9_.~-]/g, '')
    .slice(0, 50);
}

function createOrderId(requestId) {
  const cleanRequest = sanitizeOrderId(requestId).slice(0, 28);
  const time = Date.now().toString().slice(-10);

  return sanitizeOrderId(`MP-${cleanRequest || 'ORDER'}-${time}`);
}

function normalizePhone(phone) {
  const raw = String(phone || '').trim();

  if (!raw) return '';

  let digits = raw.replace(/[^\d]/g, '');

  if (!digits) return '';

  if (digits.startsWith('0')) {
    digits = `62${digits.slice(1)}`;
  }

  if (!digits.startsWith('62')) {
    digits = `62${digits}`;
  }

  return digits.slice(0, 16);
}

function isPaidStatus(value) {
  const status = String(value || '').toLowerCase().trim();

  return (
    status === 'paid' ||
    status === 'success' ||
    status === 'settlement' ||
    status === 'capture' ||
    status === 'berhasil' ||
    status === 'pembayaran berhasil' ||
    status.includes('berhasil') ||
    status.includes('lunas')
  );
}

function buildItemDetails({ requestId, serviceName, totalAmount }) {
  return [
    {
      id: sanitizeOrderId(requestId).slice(0, 50) || 'MONTIRPEDIA',
      price: totalAmount,
      quantity: 1,
      name: sanitizeText(serviceName || 'Layanan MontirPedia', 'Layanan MontirPedia').slice(0, 50),
      category: 'Service',
      merchant_name: 'MontirPedia',
    },
  ];
}

function buildCustomerDetails({
  customerName,
  customerEmail,
  customerPhone,
}) {
  const nameParts = sanitizeText(customerName, 'Pelanggan').split(' ');
  const firstName = nameParts.shift() || 'Pelanggan';
  const lastName = nameParts.join(' ');

  const customer = {
    first_name: firstName.slice(0, 50),
  };

  if (lastName) {
    customer.last_name = lastName.slice(0, 50);
  }

  if (customerEmail) {
    customer.email = sanitizeText(customerEmail, '').slice(0, 128);
  }

  if (customerPhone) {
    customer.phone = normalizePhone(customerPhone);
  }

  return customer;
}

function buildMidtransPayload({
  orderId,
  requestId,
  collection,
  totalAmount,
  serviceName,
  customerName,
  customerEmail,
  customerPhone,
}) {
  const expiryMinutes = Number(process.env.MIDTRANS_EXPIRY_MINUTES || 60);

  const payload = {
    transaction_details: {
      order_id: orderId,
      gross_amount: totalAmount,
    },
    item_details: buildItemDetails({
      requestId,
      serviceName,
      totalAmount,
    }),
    customer_details: buildCustomerDetails({
      customerName,
      customerEmail,
      customerPhone,
    }),
    custom_field1: String(requestId).slice(0, 255),
    custom_field2: String(collection).slice(0, 255),
    custom_field3: 'MontirPedia',
    expiry: {
      unit: 'minutes',
      duration: Number.isFinite(expiryMinutes) && expiryMinutes > 0
        ? expiryMinutes
        : 60,
    },
  };

  if (process.env.MIDTRANS_FINISH_REDIRECT_URL) {
    payload.callbacks = {
      finish: process.env.MIDTRANS_FINISH_REDIRECT_URL,
    };
  }

  if (process.env.MIDTRANS_ENABLED_PAYMENTS) {
    payload.enabled_payments = process.env.MIDTRANS_ENABLED_PAYMENTS
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return payload;
}

async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    return res.end();
  }

  if (req.method !== 'POST') {
    return sendJson(res, 405, {
      ok: false,
      success: false,
      message: 'Method tidak diizinkan. Gunakan POST.',
    });
  }

  try {
    const decodedToken = await verifyFirebaseTokenFromRequest(req);
    const body = parseBody(req);

    const requestId = sanitizeText(body.requestId, '');

    if (!requestId) {
      return sendJson(res, 400, {
        ok: false,
        success: false,
        message: 'requestId wajib dikirim dari aplikasi.',
      });
    }

    const totalAmount = toIntAmount(
      body.totalPrice ||
        body.grossAmount ||
        body.amount ||
        body.estimatedTotal ||
        body.appPaymentTotal
    );

    if (!totalAmount || totalAmount < 1) {
      return sendJson(res, 400, {
        ok: false,
        success: false,
        message: 'Nominal pembayaran tidak valid.',
      });
    }

    const collection = safeCollectionName(
      body.collection || body.collectionName
    );

    const db = getDb();
    const orderRef = db.collection(collection).doc(requestId);
    const orderSnapshot = await orderRef.get();

    if (!orderSnapshot.exists) {
      return sendJson(res, 404, {
        ok: false,
        success: false,
        message: `Order tidak ditemukan di koleksi ${collection}.`,
      });
    }

    const orderData = orderSnapshot.data() || {};

    if (isPaidStatus(orderData.paymentStatus)) {
      return sendJson(res, 409, {
        ok: false,
        success: false,
        message: 'Order ini sudah dibayar.',
      });
    }

    const existingGateway = String(orderData.paymentGateway || '').toLowerCase();
    const existingStatus = String(orderData.paymentStatus || '').toLowerCase();
    const existingPaymentUrl = String(orderData.paymentUrl || '').trim();
    const existingOrderId = String(orderData.midtransOrderId || orderData.paymentOrderId || '').trim();
    const existingToken = String(orderData.midtransSnapToken || '').trim();

    if (
      existingGateway === 'midtrans' &&
      existingPaymentUrl &&
      existingToken &&
      existingStatus === 'pending'
    ) {
      if (isMidtransSandboxUrl(existingPaymentUrl)) {
        return sendJson(res, 200, {
          ok: true,
          success: true,
          paymentUrl: existingPaymentUrl,
          redirectUrl: existingPaymentUrl,
          redirect_url: existingPaymentUrl,
          snapUrl: existingPaymentUrl,
          token: existingToken,
          snapToken: existingToken,
          invoiceNumber: existingOrderId,
          paymentOrderId: existingOrderId,
          midtransOrderId: existingOrderId,
          paymentEnvironment: 'sandbox',
          reused: true,
        });
      }

      // Jika URL lama adalah Production atau bukan Sandbox, hapus agar transaksi baru dibuat.
      await orderRef.set(
        {
          paymentUrl: admin.firestore.FieldValue.delete(),
          midtransPaymentUrl: admin.firestore.FieldValue.delete(),
          redirectUrl: admin.firestore.FieldValue.delete(),
          redirect_url: admin.firestore.FieldValue.delete(),
          checkoutUrl: admin.firestore.FieldValue.delete(),
          snapUrl: admin.firestore.FieldValue.delete(),
          midtransSnapToken: admin.firestore.FieldValue.delete(),
          paymentOrderId: admin.firestore.FieldValue.delete(),
          midtransOrderId: admin.firestore.FieldValue.delete(),
          paymentReady: false,
          paymentStatus: 'pending_reset_to_sandbox',
          paymentStatusLabel: isMidtransProductionUrl(existingPaymentUrl)
            ? 'URL Production lama dihapus, membuat Sandbox baru'
            : 'URL lama bukan Sandbox, membuat Sandbox baru',
          paymentEnvironment: 'sandbox',
          midtransEnvironment: 'sandbox',
          environment: 'sandbox',
          isProduction: false,
          isProductionPayment: false,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    const { snapBaseUrl, environment } = getMidtransConfig();

    const orderId = createOrderId(requestId);

    const customerName = sanitizeText(
      body.customerName ||
        orderData.customerName ||
        orderData.namaPelanggan ||
        decodedToken?.name ||
        'Pelanggan',
      'Pelanggan'
    );

    const customerEmail = sanitizeText(
      body.customerEmail ||
        orderData.customerEmail ||
        orderData.email ||
        decodedToken?.email ||
        '',
      ''
    );

    const customerPhone = normalizePhone(
      body.customerPhone ||
        orderData.customerPhone ||
        orderData.phone ||
        orderData.noHp ||
        orderData.nomorHp ||
        ''
    );

    const serviceName = sanitizeText(
      body.serviceName ||
        orderData.serviceName ||
        body.deliveryType ||
        orderData.deliveryType ||
        'Layanan MontirPedia',
      'Layanan MontirPedia'
    );

    const midtransBody = buildMidtransPayload({
      orderId,
      requestId,
      collection,
      totalAmount,
      serviceName,
      customerName,
      customerEmail,
      customerPhone,
    });

    const fetchFn = getFetch();

    if (!fetchFn) {
      throw new Error(
        'Fetch API tidak tersedia di environment backend. Pastikan Node.js 18+ atau pasang paket node-fetch.'
      );
    }

    const midtransResponse = await fetchFn(
      `${snapBaseUrl}${SNAP_TRANSACTION_TARGET}`,
      {
        method: 'POST',
        headers: createMidtransHeaders(),
        body: JSON.stringify(midtransBody),
      }
    );

    const responseText = await midtransResponse.text();

    let decodedResponse = null;

    try {
      decodedResponse = responseText ? JSON.parse(responseText) : null;
    } catch (_) {
      decodedResponse = {
        raw: responseText,
      };
    }

    if (!midtransResponse.ok) {
      return sendJson(res, midtransResponse.status, {
        ok: false,
        success: false,
        message: 'Midtrans menolak pembuatan transaksi.',
        midtransStatusCode: midtransResponse.status,
        midtransResponse: decodedResponse,
      });
    }

    const snapToken = String(decodedResponse?.token || '').trim();
    const paymentUrl = String(decodedResponse?.redirect_url || '').trim();

    if (!snapToken || !paymentUrl) {
      return sendJson(res, 502, {
        ok: false,
        success: false,
        message:
          'Midtrans berhasil dipanggil, tetapi token atau redirect_url tidak ditemukan.',
        midtransResponse: decodedResponse,
      });
    }

    if (isMidtransProductionUrl(paymentUrl) || !isMidtransSandboxUrl(paymentUrl)) {
      return sendJson(res, 500, {
        ok: false,
        success: false,
        message:
          'Backend masih menghasilkan URL Midtrans Production atau URL bukan Sandbox. Periksa MIDTRANS_SERVER_KEY dan endpoint Snap Sandbox.',
        paymentUrl,
        expectedEnvironment: 'sandbox',
      });
    }

    const now = admin.firestore.FieldValue.serverTimestamp();

    await db.collection('midtrans_payments').doc(orderId).set(
      {
        requestId,
        collection,
        orderId,
        midtransOrderId: orderId,
        amount: totalAmount,
        grossAmount: totalAmount,
        status: 'pending',
        transactionStatus: 'pending',
        paymentGateway: 'midtrans',
        paymentMethod: 'Midtrans Sandbox',
        paymentEnvironment: environment,
        paymentUrl,
        redirectUrl: paymentUrl,
        snapToken,
        customerName,
        customerEmail,
        customerPhone,
        serviceName,
        createdAt: now,
        updatedAt: now,
        rawMidtransRequest: midtransBody,
        rawMidtransResponse: decodedResponse,
      },
      { merge: true }
    );

    await orderRef.set(
      {
        requestId,
        paymentGateway: 'midtrans',
        paymentMethod: 'Midtrans Sandbox',
        metodePembayaran: 'Midtrans Sandbox',
        paymentEnvironment: environment,
        midtransEnvironment: environment,
        environment,
        isProduction: false,
        isProductionPayment: false,
        paymentStatus: 'pending',
        paymentStatusLabel: 'Menunggu Pembayaran Sandbox',
        statusOrder: 'Menunggu Pembayaran',
        status: 'Menunggu Pembayaran',
        Status: 'Menunggu Pembayaran',
        paymentReady: true,
        paymentUrl,
        midtransPaymentUrl: paymentUrl,
        paymentOrderId: orderId,
        midtransOrderId: orderId,
        midtransSnapToken: snapToken,
        estimatedTotal: totalAmount,
        grossAmount: totalAmount,
        totalAmount,
        updatedAt: now,
      },
      { merge: true }
    );

    return sendJson(res, 200, {
      ok: true,
      success: true,
      paymentUrl,
      redirectUrl: paymentUrl,
      redirect_url: paymentUrl,
      snapUrl: paymentUrl,
      token: snapToken,
      snapToken,
      invoiceNumber: orderId,
      paymentOrderId: orderId,
      midtransOrderId: orderId,
      paymentGateway: 'midtrans',
      paymentMethod: 'Midtrans Sandbox',
      paymentEnvironment: environment,
      midtransEnvironment: environment,
      environment,
      isProduction: false,
      isProductionPayment: false,
      response: decodedResponse,
    });
  } catch (error) {
    console.error('create-midtrans-transaction error:', error);

    return sendJson(res, 500, {
      ok: false,
      success: false,
      message:
        error.message || 'Terjadi kesalahan saat membuat transaksi Midtrans.',
    });
  }
}

module.exports = handler;