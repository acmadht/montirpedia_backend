const crypto = require('crypto');

const {
  admin,
  getDb,
} = require('../lib/firebaseAdmin');

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

function readRawBody(req) {
  if (req.body && typeof req.body === 'object') {
    return Promise.resolve(JSON.stringify(req.body));
  }

  if (typeof req.body === 'string') {
    return Promise.resolve(req.body);
  }

  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on('data', (chunk) => {
      chunks.push(Buffer.from(chunk));
    });

    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    req.on('error', reject);
  });
}

function safeLower(value) {
  return String(value || '').toLowerCase().trim();
}

function safeString(value) {
  return String(value || '').trim();
}

function getMidtransServerKey() {
  const serverKey = safeString(process.env.MIDTRANS_SERVER_KEY);

  if (!serverKey) {
    throw new Error('MIDTRANS_SERVER_KEY belum diatur di environment backend.');
  }

  return serverKey;
}

function shouldSkipSignatureVerify() {
  return safeLower(process.env.MIDTRANS_SKIP_SIGNATURE_VERIFY) === 'true';
}

function verifyMidtransSignature(payload) {
  const serverKey = getMidtransServerKey();

  const orderId = safeString(payload.order_id);
  const statusCode = safeString(payload.status_code);
  const grossAmount = safeString(payload.gross_amount);
  const signatureKey = safeString(payload.signature_key);

  if (!orderId || !statusCode || !grossAmount || !signatureKey) {
    return {
      ok: false,
      reason:
        'Data signature Midtrans tidak lengkap. Pastikan order_id, status_code, gross_amount, dan signature_key tersedia.',
    };
  }

  const expectedSignature = crypto
    .createHash('sha512')
    .update(orderId + statusCode + grossAmount + serverKey)
    .digest('hex');

  const left = Buffer.from(signatureKey, 'utf8');
  const right = Buffer.from(expectedSignature, 'utf8');

  if (left.length !== right.length) {
    return {
      ok: false,
      reason: 'Signature Midtrans tidak valid.',
    };
  }

  const valid = crypto.timingSafeEqual(left, right);

  return {
    ok: valid,
    reason: valid ? '' : 'Signature Midtrans tidak valid.',
  };
}

function extractNotificationData(payload) {
  return {
    orderId: safeString(payload.order_id),
    transactionId: safeString(payload.transaction_id),
    transactionStatus: safeString(payload.transaction_status),
    fraudStatus: safeString(payload.fraud_status),
    statusCode: safeString(payload.status_code),
    statusMessage: safeString(payload.status_message),
    grossAmount: safeString(payload.gross_amount),
    paymentType: safeString(payload.payment_type),
    transactionTime: safeString(payload.transaction_time),
    settlementTime: safeString(payload.settlement_time),
    expiryTime: safeString(payload.expiry_time),
    merchantId: safeString(payload.merchant_id),
    currency: safeString(payload.currency),
    customField1: safeString(payload.custom_field1),
    customField2: safeString(payload.custom_field2),
    customField3: safeString(payload.custom_field3),
  };
}

function parseDateOrServerTimestamp(value) {
  const text = safeString(value);

  if (!text) {
    return admin.firestore.FieldValue.serverTimestamp();
  }

  const parsed = new Date(text.replace(' ', 'T'));

  if (Number.isNaN(parsed.getTime())) {
    return admin.firestore.FieldValue.serverTimestamp();
  }

  return parsed;
}

function isPaidLikeStatus(value) {
  const status = safeLower(value);

  return (
    status === 'paid' ||
    status === 'success' ||
    status === 'settlement' ||
    status === 'capture' ||
    status === 'pembayaran berhasil' ||
    status === 'berhasil' ||
    status.includes('berhasil') ||
    status.includes('lunas')
  );
}

function mapPaymentStatus(transactionStatus, fraudStatus) {
  const status = safeLower(transactionStatus);
  const fraud = safeLower(fraudStatus);

  if (status === 'settlement') {
    return {
      paymentStatus: 'Pembayaran Berhasil',
      paymentStatusCode: 'paid',
      paymentStatusLabel: 'Pembayaran Berhasil',
      statusOrder: 'Menunggu Konfirmasi Admin',
      status: 'Menunggu Konfirmasi Admin',
      paid: true,
      pending: false,
      failed: false,
      refunded: false,
    };
  }

  if (status === 'capture') {
    if (!fraud || fraud === 'accept') {
      return {
        paymentStatus: 'Pembayaran Berhasil',
        paymentStatusCode: 'paid',
        paymentStatusLabel: 'Pembayaran Berhasil',
        statusOrder: 'Menunggu Konfirmasi Admin',
        status: 'Menunggu Konfirmasi Admin',
        paid: true,
        pending: false,
        failed: false,
        refunded: false,
      };
    }

    if (fraud === 'challenge') {
      return {
        paymentStatus: 'pending',
        paymentStatusCode: 'pending_fraud_review',
        paymentStatusLabel: 'Menunggu Review Pembayaran',
        statusOrder: 'Menunggu Review Pembayaran',
        status: 'Menunggu Review Pembayaran',
        paid: false,
        pending: true,
        failed: false,
        refunded: false,
      };
    }
  }

  if (status === 'pending' || status === 'authorize') {
    return {
      paymentStatus: 'pending',
      paymentStatusCode: 'pending',
      paymentStatusLabel: 'Menunggu Pembayaran',
      statusOrder: 'Menunggu Pembayaran',
      status: 'Menunggu Pembayaran',
      paid: false,
      pending: true,
      failed: false,
      refunded: false,
    };
  }

  if (
    status === 'deny' ||
    status === 'cancel' ||
    status === 'expire' ||
    status === 'failure'
  ) {
    const isExpired = status === 'expire';
    const label = isExpired ? 'Pembayaran Kedaluwarsa' : 'Pembayaran Gagal';

    return {
      paymentStatus: isExpired ? 'expired' : 'failed',
      paymentStatusCode: status,
      paymentStatusLabel: label,
      statusOrder: label,
      status: label,
      paid: false,
      pending: false,
      failed: true,
      refunded: false,
    };
  }

  if (
    status === 'refund' ||
    status === 'partial_refund' ||
    status === 'chargeback' ||
    status === 'partial_chargeback'
  ) {
    return {
      paymentStatus: 'refunded',
      paymentStatusCode: status,
      paymentStatusLabel: 'Pembayaran Dikembalikan',
      statusOrder: 'Pembayaran Dikembalikan',
      status: 'Pembayaran Dikembalikan',
      paid: false,
      pending: false,
      failed: false,
      refunded: true,
    };
  }

  return {
    paymentStatus: status || 'pending',
    paymentStatusCode: status || 'pending',
    paymentStatusLabel: 'Menunggu Pembayaran',
    statusOrder: 'Menunggu Pembayaran',
    status: 'Menunggu Pembayaran',
    paid: false,
    pending: true,
    failed: false,
    refunded: false,
  };
}

function shouldIgnoreOutOfOrderPending({ mapped, paymentData, orderData }) {
  if (!mapped.pending) return false;

  return (
    isPaidLikeStatus(paymentData?.status) ||
    isPaidLikeStatus(paymentData?.paymentStatus) ||
    isPaidLikeStatus(orderData?.paymentStatus)
  );
}

function buildPaymentMethodLabel(paymentType) {
  const type = safeString(paymentType);

  if (!type) return 'Midtrans Snap';

  return `Midtrans ${type}`;
}

async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method !== 'POST') {
    return sendJson(res, 405, {
      ok: false,
      message: 'Method tidak diizinkan. Gunakan POST.',
    });
  }

  try {
    const rawBody = await readRawBody(req);
    let payload = null;

    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch (_) {
      return sendJson(res, 400, {
        ok: false,
        message: 'Body webhook Midtrans bukan JSON valid.',
      });
    }

    if (!shouldSkipSignatureVerify()) {
      const verification = verifyMidtransSignature(payload);

      if (!verification.ok) {
        console.error('Midtrans signature invalid:', verification.reason);
        return sendJson(res, 401, {
          ok: false,
          message: verification.reason,
        });
      }
    }

    const data = extractNotificationData(payload);

    if (!data.orderId) {
      return sendJson(res, 400, {
        ok: false,
        message: 'order_id tidak ditemukan di webhook Midtrans.',
      });
    }

    const mapped = mapPaymentStatus(data.transactionStatus, data.fraudStatus);
    const db = getDb();
    const now = admin.firestore.FieldValue.serverTimestamp();

    const paymentRef = db.collection('midtrans_payments').doc(data.orderId);
    const paymentSnapshot = await paymentRef.get();
    const paymentData = paymentSnapshot.exists
      ? paymentSnapshot.data() || {}
      : {};

    const collection =
      safeString(paymentData.collection) ||
      safeString(data.customField2) ||
      'pickup_delivery_requests';

    const requestId =
      safeString(paymentData.requestId) ||
      safeString(data.customField1) ||
      '';

    let orderData = {};
    let orderRef = null;

    if (requestId) {
      orderRef = db.collection(collection).doc(requestId);
      const orderSnapshot = await orderRef.get();
      orderData = orderSnapshot.exists ? orderSnapshot.data() || {} : {};
    }

    if (shouldIgnoreOutOfOrderPending({ mapped, paymentData, orderData })) {
      await paymentRef.set(
        {
          lastIgnoredNotification: payload,
          lastIgnoredReason:
            'Notifikasi pending diabaikan karena transaksi sebelumnya sudah tercatat berhasil.',
          updatedAt: now,
        },
        { merge: true }
      );

      return sendJson(res, 200, {
        ok: true,
        message: 'Notification ignored because payment is already marked as paid.',
        orderId: data.orderId,
        requestId,
        collection,
      });
    }

    const paymentUpdate = {
      orderId: data.orderId,
      midtransOrderId: data.orderId,
      requestId: requestId || null,
      collection,
      status: mapped.paymentStatus,
      paymentStatus: mapped.paymentStatus,
      paymentStatusCode: mapped.paymentStatusCode,
      paymentStatusLabel: mapped.paymentStatusLabel,
      transactionStatus: data.transactionStatus,
      fraudStatus: data.fraudStatus,
      statusCode: data.statusCode,
      statusMessage: data.statusMessage,
      transactionId: data.transactionId,
      grossAmount: data.grossAmount,
      paymentType: data.paymentType,
      paymentMethod: buildPaymentMethodLabel(data.paymentType),
      transactionTime: data.transactionTime,
      settlementTime: data.settlementTime,
      expiryTime: data.expiryTime,
      merchantId: data.merchantId,
      currency: data.currency,
      customField1: data.customField1,
      customField2: data.customField2,
      customField3: data.customField3,
      rawNotification: payload,
      updatedAt: now,
    };

    if (!paymentSnapshot.exists) {
      paymentUpdate.createdAt = now;
      paymentUpdate.notificationWithoutInitialPaymentDocument = true;
    }

    if (mapped.paid) {
      paymentUpdate.paidAt = parseDateOrServerTimestamp(
        data.settlementTime || data.transactionTime
      );
    }

    if (mapped.failed) {
      paymentUpdate.failedAt = now;
    }

    if (mapped.refunded) {
      paymentUpdate.refundedAt = now;
    }

    await paymentRef.set(paymentUpdate, { merge: true });

    if (!requestId || !orderRef) {
      return sendJson(res, 200, {
        ok: true,
        message:
          'Notification received, tetapi mapping requestId belum ditemukan.',
        orderId: data.orderId,
        paymentStatus: mapped.paymentStatus,
      });
    }

    const orderUpdate = {
      paymentGateway: 'midtrans',
      paymentMethod: buildPaymentMethodLabel(data.paymentType),
      metodePembayaran: buildPaymentMethodLabel(data.paymentType),
      paymentStatus: mapped.paymentStatus,
      paymentStatusCode: mapped.paymentStatusCode,
      paymentStatusLabel: mapped.paymentStatusLabel,
      statusOrder: mapped.statusOrder,
      status: mapped.status,
      Status: mapped.status,
      midtransOrderId: data.orderId,
      paymentOrderId: data.orderId,
      midtransTransactionId: data.transactionId,
      midtransTransactionStatus: data.transactionStatus,
      midtransFraudStatus: data.fraudStatus,
      midtransStatusCode: data.statusCode,
      midtransStatusMessage: data.statusMessage,
      midtransPaymentType: data.paymentType,
      midtransGrossAmount: data.grossAmount,
      midtransSettlementTime: data.settlementTime,
      midtransTransactionTime: data.transactionTime,
      midtransRawNotification: payload,
      updatedAt: now,
    };

    if (mapped.paid) {
      const paidAt = parseDateOrServerTimestamp(
        data.settlementTime || data.transactionTime
      );

      orderUpdate.paidAt = paidAt;
      orderUpdate.paymentPaidAt = paidAt;
      orderUpdate.paymentReady = false;
    }

    if (mapped.failed) {
      orderUpdate.paymentFailedAt = now;
    }

    if (mapped.refunded) {
      orderUpdate.paymentRefundedAt = now;
    }

    await orderRef.set(orderUpdate, { merge: true });

    return sendJson(res, 200, {
      ok: true,
      message: 'SUCCESS',
      orderId: data.orderId,
      requestId,
      collection,
      transactionStatus: data.transactionStatus,
      fraudStatus: data.fraudStatus,
      paymentStatus: mapped.paymentStatus,
    });
  } catch (error) {
    console.error('midtrans-notification error:', error);

    return sendJson(res, 500, {
      ok: false,
      message:
        error.message || 'Terjadi kesalahan saat memproses webhook Midtrans.',
    });
  }
}

module.exports = handler;

module.exports.config = {
  api: {
    bodyParser: false,
  },
};