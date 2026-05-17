const {
  admin,
  getDb,
  verifyFirebaseTokenFromRequest,
} = require('../lib/firebaseAdmin');

const PICKUP_DELIVERY_COLLECTION =
  process.env.PICKUP_DELIVERY_COLLECTION || 'pickup_delivery_requests';
const USERS_COLLECTION = process.env.USERS_COLLECTION || 'users';
const NOTIFICATIONS_COLLECTION =
  process.env.NOTIFICATIONS_COLLECTION || 'notifications';
const NOTIFICATION_LOGS_COLLECTION =
  process.env.NOTIFICATION_LOGS_COLLECTION || 'notification_logs';
const ANDROID_NOTIFICATION_CHANNEL_ID =
  process.env.ANDROID_NOTIFICATION_CHANNEL_ID ||
  'montirpedia_order_sound_channel_v1';
const ANDROID_NOTIFICATION_SOUND =
  process.env.ANDROID_NOTIFICATION_SOUND || 'montirpedia';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
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
  if (req.body && typeof req.body === 'object') return req.body;

  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch (_) {
      return {};
    }
  }

  return {};
}

function text(value, fallback = '') {
  const result = String(value ?? fallback).trim();
  return result || fallback;
}

function cleanKey(value) {
  return text(value).toLowerCase().replace(/\s+/g, '_').replace(/-/g, '_');
}

function now() {
  return admin.firestore.FieldValue.serverTimestamp();
}

function readText(data, keys, fallback = '-') {
  for (const key of keys) {
    const value = data && data[key];

    if (value !== undefined && value !== null) {
      const result = String(value).trim();

      if (result && result.toLowerCase() !== 'null') return result;
    }
  }

  return fallback;
}

function readMotorLabel(orderData) {
  const vehicle = readText(
    orderData,
    ['vehicleName', 'kendaraan', 'vehicleType', 'jenisKendaraan', 'motorName'],
    ''
  );

  const plate = readText(orderData, ['plateNumber', 'nomorPolisi', 'nopol'], '');

  if (vehicle && plate) return `${vehicle} • ${plate}`;
  if (vehicle) return vehicle;
  if (plate) return plate;

  return 'Motor customer';
}

function readAddress(orderData) {
  return readText(
    orderData,
    [
      'pickupAddress',
      'alamatJemput',
      'alamat',
      'customerAddress',
      'address',
      'originAddress',
      'lokasiJemput',
    ],
    'Alamat belum tersedia'
  );
}

function readDestination(orderData) {
  return readText(
    orderData,
    [
      'destinationAddress',
      'alamatTujuan',
      'bengkelAddress',
      'workshopAddress',
      'tujuan',
      'destination',
    ],
    ''
  );
}

function readCustomer(orderData) {
  return readText(
    orderData,
    ['customerName', 'nama', 'name', 'namaCustomer'],
    'Customer'
  );
}

function notificationContent(eventType, orderData, requestId) {
  const event = cleanKey(eventType || 'pickup_delivery_new_order');
  const customer = readCustomer(orderData);
  const motor = readMotorLabel(orderData);
  const pickupAddress = readAddress(orderData);
  const destination = readDestination(orderData);

  if (
    event === 'pickup_delivery_new_order' ||
    event === 'new_order' ||
    event === 'jemput_antar_new_order'
  ) {
    return {
      title: 'Order Jemput Antar Baru',
      body: destination
        ? `${customer} meminta Jemput Antar untuk ${motor}. Jemput: ${pickupAddress}. Tujuan: ${destination}.`
        : `${customer} meminta Jemput Antar untuk ${motor}. Lokasi jemput: ${pickupAddress}.`,
      type: 'pickup_delivery_new_order',
      status: 'waiting_admin_followup',
      action: 'open_admin_pickup_delivery',
      showPopup: 'true',
    };
  }

  if (
    event === 'pickup_delivery_payment_created' ||
    event === 'payment_created'
  ) {
    return {
      title: 'Pembayaran Jemput Antar Dibuat',
      body: `Link pembayaran Jemput Antar untuk ${customer} sudah dibuat.`,
      type: 'pickup_delivery_payment_created',
      status: 'waiting_payment',
      action: 'open_admin_pickup_delivery',
      showPopup: 'true',
    };
  }

  if (
    event === 'pickup_delivery_payment_success' ||
    event === 'payment_success' ||
    event === 'paid'
  ) {
    return {
      title: 'Pembayaran Jemput Antar Berhasil',
      body: `${customer} sudah membayar layanan Jemput Antar.`,
      type: 'pickup_delivery_payment_success',
      status: 'paid',
      action: 'open_admin_pickup_delivery',
      showPopup: 'true',
    };
  }

  return {
    title: 'Update Jemput Antar',
    body: `Ada update baru untuk order Jemput Antar ${requestId}.`,
    type: 'pickup_delivery_update',
    status: event,
    action: 'open_admin_pickup_delivery',
    showPopup: 'true',
  };
}

async function getOrder(db, requestId) {
  const collectionRef = db.collection(PICKUP_DELIVERY_COLLECTION);

  const docSnap = await collectionRef.doc(requestId).get();

  if (docSnap.exists) {
    return {
      id: docSnap.id,
      ref: docSnap.ref,
      data: docSnap.data() || {},
    };
  }

  const fields = ['requestId', 'orderId', 'id'];

  for (const field of fields) {
    const querySnap = await collectionRef
      .where(field, '==', requestId)
      .limit(1)
      .get();

    if (!querySnap.empty) {
      const doc = querySnap.docs[0];

      return {
        id: doc.id,
        ref: doc.ref,
        data: doc.data() || {},
      };
    }
  }

  throw new Error(
    `Order Jemput Antar tidak ditemukan di ${PICKUP_DELIVERY_COLLECTION}. requestId=${requestId}`
  );
}

function readTokens(userData) {
  const tokens = new Set();

  if (typeof userData.fcmToken === 'string' && userData.fcmToken.trim()) {
    tokens.add(userData.fcmToken.trim());
  }

  if (Array.isArray(userData.fcmTokens)) {
    userData.fcmTokens.forEach((token) => {
      if (typeof token === 'string' && token.trim()) {
        tokens.add(token.trim());
      }
    });
  }

  return Array.from(tokens);
}

async function getAdminDocs(db) {
  const usersRef = db.collection(USERS_COLLECTION);
  const docs = new Map();

  const roles = ['admin', 'superadmin', 'super_admin', 'administrator'];

  for (const role of roles) {
    try {
      const snap = await usersRef.where('role', '==', role).get();
      snap.docs.forEach((doc) => docs.set(doc.id, doc));
    } catch (error) {
      console.error(`Query admin role ${role} gagal:`, error.message);
    }
  }

  try {
    const snap = await usersRef.where('isAdmin', '==', true).get();
    snap.docs.forEach((doc) => docs.set(doc.id, doc));
  } catch (error) {
    console.error('Query isAdmin gagal:', error.message);
  }

  return Array.from(docs.values());
}

function collectTokensFromDocs(docs) {
  const tokens = new Set();

  docs.forEach((doc) => {
    const data = doc.data() || {};
    readTokens(data).forEach((token) => tokens.add(token));
  });

  return Array.from(tokens);
}

async function sendAdminNotification(firebaseAdmin, tokens, content, dataPayload) {
  const cleanTokens = Array.from(new Set(tokens)).filter(Boolean).slice(0, 500);

  if (cleanTokens.length === 0) {
    return {
      tokenCount: 0,
      successCount: 0,
      failureCount: 0,
      errors: [],
    };
  }

  const result = await firebaseAdmin.messaging().sendEachForMulticast({
    tokens: cleanTokens,
    notification: {
      title: content.title,
      body: content.body,
    },
    data: Object.fromEntries(
      Object.entries(dataPayload).map(([key, value]) => [
        key,
        String(value ?? ''),
      ])
    ),
    android: {
      priority: 'high',
      notification: {
        channelId: ANDROID_NOTIFICATION_CHANNEL_ID,
        sound: ANDROID_NOTIFICATION_SOUND,
        priority: 'high',
        defaultSound: false,
        defaultVibrateTimings: true,
      },
    },
    apns: {
      payload: {
        aps: {
          sound: `${ANDROID_NOTIFICATION_SOUND}.wav`,
          badge: 1,
        },
      },
    },
  });

  return {
    tokenCount: cleanTokens.length,
    successCount: result.successCount,
    failureCount: result.failureCount,
    errors: result.responses
      .map((item, index) => {
        if (item.success) return null;

        return {
          index,
          code: item.error?.code || null,
          message: item.error?.message || 'Unknown error',
        };
      })
      .filter(Boolean),
  };
}

async function saveNotification(db, payload) {
  const doc = await db.collection(NOTIFICATIONS_COLLECTION).add({
    ...payload,
    read: false,
    createdAt: now(),
    updatedAt: now(),
  });

  return doc.id;
}

async function saveLog(db, payload) {
  await db.collection(NOTIFICATION_LOGS_COLLECTION).add({
    ...payload,
    createdAt: now(),
  });
}

async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    return res.end();
  }

  if (req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      success: true,
      endpoint: '/api/send-pickup-delivery-admin-notification',
      method: 'POST',
      status: 'online',
      collection: PICKUP_DELIVERY_COLLECTION,
    });
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

    const requestId = text(body.requestId || body.orderId || body.id);
    const eventType = text(
      body.eventType || body.type || 'pickup_delivery_new_order'
    );

    if (!requestId) {
      return sendJson(res, 400, {
        ok: false,
        success: false,
        message: 'requestId wajib dikirim.',
      });
    }

    const db = getDb();
    const order = await getOrder(db, requestId);
    const orderData = order.data || {};
    const content = notificationContent(eventType, orderData, requestId);
    const adminDocs = await getAdminDocs(db);
    const tokens = collectTokensFromDocs(adminDocs);

    const dataPayload = {
      requestId,
      orderId: requestId,
      collection: PICKUP_DELIVERY_COLLECTION,
      collectionName: PICKUP_DELIVERY_COLLECTION,
      sourceCollection: PICKUP_DELIVERY_COLLECTION,
      target: 'admin',
      targetRole: 'admin',
      type: content.type,
      eventType,
      status: content.status,
      title: content.title,
      body: content.body,
      showPopup: content.showPopup,
      action: content.action,
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
    };

    const notificationId = await saveNotification(db, {
      ...dataPayload,
      showPopup: content.showPopup === 'true',
      createdByUid: decodedToken?.uid || '',
    });

    const fcmResult = await sendAdminNotification(
      admin,
      tokens,
      content,
      {
        ...dataPayload,
        notificationId,
      }
    );

    await order.ref.set(
      {
        showAdminPopup: true,
        adminPopupRequired: true,
        adminActionRequired: true,
        adminPopupHandled: false,
        adminStatusLabel: content.title,
        lastAdminNotificationAt: now(),
        lastAdminNotificationType: content.type,
        lastAdminNotificationEventType: eventType,
        lastAdminNotificationFcmResult: fcmResult,
        notificationTarget: 'admin',
        notificationType: content.type,
        updatedAt: now(),
      },
      { merge: true }
    );

    await saveLog(db, {
      requestId,
      orderId: requestId,
      collection: PICKUP_DELIVERY_COLLECTION,
      target: 'admin',
      type: content.type,
      eventType,
      tokenCount: fcmResult.tokenCount,
      successCount: fcmResult.successCount,
      failureCount: fcmResult.failureCount,
      errors: fcmResult.errors,
      notificationId,
      createdByUid: decodedToken?.uid || '',
    });

    return sendJson(res, 200, {
      ok: true,
      success: true,
      message: 'Notifikasi admin Jemput Antar berhasil diproses.',
      requestId,
      type: content.type,
      eventType,
      recipientCount: adminDocs.length,
      fcmResult,
      notificationId,
    });
  } catch (error) {
    console.error('send-pickup-delivery-admin-notification error:', error);

    return sendJson(res, 500, {
      ok: false,
      success: false,
      message:
        error.message ||
        'Terjadi kesalahan saat mengirim notifikasi admin Jemput Antar.',
    });
  }
}

module.exports = handler;
