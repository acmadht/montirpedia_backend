const crypto = require('crypto');

const SNAP_TRANSACTION_TARGET = '/snap/v1/transactions';

function isProduction() {
  return String(process.env.MIDTRANS_IS_PRODUCTION || 'false')
    .toLowerCase()
    .trim() === 'true';
}

function getMidtransConfig() {
  const serverKey = process.env.MIDTRANS_SERVER_KEY;
  const clientKey = process.env.MIDTRANS_CLIENT_KEY || '';

  if (!serverKey) {
    throw new Error('MIDTRANS_SERVER_KEY belum diatur di environment backend.');
  }

  const production = isProduction();

  return {
    serverKey,
    clientKey,
    isProduction: production,
    snapBaseUrl: production
      ? 'https://app.midtrans.com'
      : 'https://app.sandbox.midtrans.com',
    apiBaseUrl: production
      ? 'https://api.midtrans.com'
      : 'https://api.sandbox.midtrans.com',
  };
}

function createBasicAuthHeader() {
  const { serverKey } = getMidtransConfig();
  const authString = Buffer.from(`${serverKey}:`).toString('base64');

  return `Basic ${authString}`;
}

function createSnapHeaders() {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: createBasicAuthHeader(),
  };
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

function verifyMidtransSignature(payload) {
  const { serverKey } = getMidtransConfig();

  const orderId = String(payload.order_id || '');
  const statusCode = String(payload.status_code || '');
  const grossAmount = String(payload.gross_amount || '');
  const signatureKey = String(payload.signature_key || '');

  if (!orderId || !statusCode || !grossAmount || !signatureKey) {
    return {
      ok: false,
      reason: 'Data signature Midtrans tidak lengkap.',
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

module.exports = {
  SNAP_TRANSACTION_TARGET,
  getMidtransConfig,
  createSnapHeaders,
  sanitizeText,
  createOrderId,
  normalizePhone,
  verifyMidtransSignature,
};