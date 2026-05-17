const admin = require('firebase-admin');

const USERS_COLLECTION = process.env.USERS_COLLECTION || 'users';
const SPAREPART_ORDERS_COLLECTION =
  process.env.SPAREPART_ORDERS_COLLECTION || 'sparepart_orders';
const NOTIFICATIONS_COLLECTION =
  process.env.NOTIFICATIONS_COLLECTION || 'notifications';
const NOTIFICATION_LOGS_COLLECTION =
  process.env.NOTIFICATION_LOGS_COLLECTION || 'notification_logs';
const ANDROID_NOTIFICATION_CHANNEL_ID =
  process.env.ANDROID_NOTIFICATION_CHANNEL_ID ||
  'montirpedia_order_sound_channel_v1';
const ANDROID_NOTIFICATION_SOUND =
  process.env.ANDROID_NOTIFICATION_SOUND || 'montirpedia';

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function initFirebaseAdmin() {
  if (admin.apps.length > 0) return admin;

  const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  const serviceAccountKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

  if (!serviceAccountBase64 && !serviceAccountKey) {
    throw new Error('Firebase service account belum diset di Environment Variables Vercel.');
  }

  const serviceAccount = serviceAccountBase64
    ? JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('utf8'))
    : JSON.parse(serviceAccountKey);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  return admin;
}

function parseBody(req) {
  if (!req || !req.body) return {};
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  if (typeof req.body === 'object') return req.body;
  return {};
}

function toText(value, fallback = '') {
  const text = String(value ?? fallback).trim();
  return text || fallback;
}

function cleanKey(value) {
  return toText(value).toLowerCase().replace(/\s+/g, '_').replace(/-/g, '_');
}

function nowTimestamp() {
  return admin.firestore.FieldValue.serverTimestamp();
}

async function verifyAuthToken(req, firebaseAdmin) {
  const authHeader = req.headers.authorization || '';

  if (!authHeader.startsWith('Bearer ')) {
    throw new Error('Authorization token tidak ditemukan.');
  }

  const idToken = authHeader.replace('Bearer ', '').trim();

  if (!idToken) {
    throw new Error('Firebase ID token kosong.');
  }

  return firebaseAdmin.auth().verifyIdToken(idToken);
}

function readTokensFromUserData(userData) {
  const tokens = new Set();

  if (typeof userData?.fcmToken === 'string' && userData.fcmToken.trim()) {
    tokens.add(userData.fcmToken.trim());
  }

  if (Array.isArray(userData?.fcmTokens)) {
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
  const docMap = new Map();
  const roleValues = ['admin', 'superadmin', 'super_admin'];

  for (const role of roleValues) {
    try {
      const snap = await usersRef.where('role', '==', role).get();
      snap.docs.forEach((doc) => docMap.set(doc.id, doc));
    } catch (error) {
      console.error(`Query admin role ${role} gagal:`, error.message);
    }
  }

  try {
    const snap = await usersRef.where('isAdmin', '==', true).get();
    snap.docs.forEach((doc) => docMap.set(doc.id, doc));
  } catch (error) {
    console.error('Query admin flag gagal:', error.message);
  }

  return Array.from(docMap.values());
}

async function getSparepartOrder(db, requestId) {
  const collectionRef = db.collection(SPAREPART_ORDERS_COLLECTION);
  const candidates = Array.from(new Set([
    requestId,
    requestId.replace(/^SP-/, ''),
    requestId.replace(/^SPAREPART-/, ''),
    requestId.replace(/^ORDER-/, ''),
  ].map((item) => toText(item)).filter(Boolean)));

  for (const id of candidates) {
    const docSnap = await collectionRef.doc(id).get();
    if (docSnap.exists) {
      return {
        ref: docSnap.ref,
        id: docSnap.id,
        data: docSnap.data() || {},
      };
    }
  }

  const fields = ['requestId', 'orderId', 'id'];

  for (const id of candidates) {
    for (const field of fields) {
      const querySnap = await collectionRef.where(field, '==', id).limit(1).get();
      if (!querySnap.empty) {
        const doc = querySnap.docs[0];
        return {
          ref: doc.ref,
          id: doc.id,
          data: doc.data() || {},
        };
      }
    }
  }

  throw new Error(`Data ${SPAREPART_ORDERS_COLLECTION} tidak ditemukan. requestId=${requestId}`);
}

function readCustomerName(orderData) {
  return toText(orderData.customerName || orderData.nama || orderData.name, 'Customer');
}

function readOrderLabel(orderData) {
  const itemCount = Number(orderData.itemCount || 0);
  const rawItems = Array.isArray(orderData.items) ? orderData.items : [];

  if (itemCount > 0) {
    return `${itemCount} item sparepart`;
  }

  if (rawItems.length > 0) {
    const firstItem = rawItems[0] || {};
    const firstName = toText(firstItem.name || firstItem.nama || firstItem.productName, 'Sparepart');
    return rawItems.length === 1 ? firstName : `${firstName} + ${rawItems.length - 1} item`;
  }

  return toText(orderData.serviceName || orderData.jenisLayanan, 'Beli Sparepart');
}

function readTotal(orderData) {
  const value =
    orderData.estimatedTotal ||
    orderData.totalPrice ||
    orderData.totalAmount ||
    orderData.grossAmount ||
    orderData.appPaymentTotal ||
    0;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function formatRupiah(value) {
  return `Rp ${Math.round(Number(value) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}

function eventContent(eventType, orderData, requestId) {
  const event = cleanKey(eventType || 'new_order');
  const customerName = readCustomerName(orderData);
  const orderLabel = readOrderLabel(orderData);
  const total = formatRupiah(readTotal(orderData));

  if (
    event === 'new_order' ||
    event === 'sparepart_new_order' ||
    event === 'admin_sparepart_new_order'
  ) {
    return {
      title: 'Order Sparepart Baru',
      body: `${customerName} membuat order ${orderLabel}. Total ${total}.`,
      type: 'admin_sparepart_new_order',
      status: 'new_order',
      action: 'open_admin_sparepart',
      showPopup: 'true',
    };
  }

  if (
    event === 'payment_success' ||
    event === 'payment_paid' ||
    event === 'pembayaran_berhasil' ||
    event === 'sparepart_payment_success'
  ) {
    return {
      title: 'Pembayaran Sparepart Berhasil',
      body: `${customerName} sudah membayar order ${orderLabel}. Segera proses pesanan sparepart.`,
      type: 'admin_sparepart_payment_success',
      status: 'payment_success',
      action: 'open_admin_sparepart',
      showPopup: 'true',
    };
  }

  if (event === 'status_update' || event === 'status_changed') {
    const statusLabel = toText(
      orderData.statusOrder || orderData.status || orderData.orderStatus,
      'Status diperbarui'
    );
    return {
      title: 'Status Sparepart Berubah',
      body: `Order ${requestId} berubah menjadi ${statusLabel}.`,
      type: 'admin_sparepart_status_update',
      status: statusLabel,
      action: 'open_admin_sparepart',
      showPopup: 'false',
    };
  }

  return {
    title: 'Update Sparepart',
    body: `Ada update baru untuk order ${requestId}.`,
    type: 'admin_sparepart_update',
    status: event,
    action: 'open_admin_sparepart',
    showPopup: 'false',
  };
}

function collectTokensFromDocs(docs) {
  const tokens = new Set();
  docs.forEach((doc) => {
    readTokensFromUserData(doc.data() || {}).forEach((token) => tokens.add(token));
  });
  return Array.from(tokens);
}

async function sendMulticast(firebaseAdmin, tokens, payload) {
  const cleanTokens = Array.from(new Set(tokens || [])).filter(Boolean).slice(0, 500);

  if (cleanTokens.length === 0) {
    return {
      tokenCount: 0,
      successCount: 0,
      failureCount: 0,
      errors: [],
    };
  }

  const response = await firebaseAdmin.messaging().sendEachForMulticast({
    tokens: cleanTokens,
    notification: {
      title: payload.title,
      body: payload.body,
    },
    data: Object.fromEntries(
      Object.entries(payload.data || {}).map(([key, value]) => [key, String(value ?? '')])
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
    webpush: {
      notification: {
        title: payload.title,
        body: payload.body,
        requireInteraction: true,
      },
      fcmOptions: {
        link: 'https://montirpedia-backend.vercel.app',
      },
    },
  });

  return {
    tokenCount: cleanTokens.length,
    successCount: response.successCount,
    failureCount: response.failureCount,
    errors: response.responses
      .map((item, index) => {
        if (item.success) return null;
        return {
          index,
          errorCode: item.error?.code || null,
          errorMessage: item.error?.message || 'Unknown error',
        };
      })
      .filter(Boolean),
  };
}

async function saveNotificationDoc(db, payload) {
  const docRef = await db.collection(NOTIFICATIONS_COLLECTION).add({
    ...payload,
    read: false,
    createdAt: nowTimestamp(),
    updatedAt: nowTimestamp(),
  });

  return docRef.id;
}

async function saveNotificationLog(db, payload) {
  await db.collection(NOTIFICATION_LOGS_COLLECTION).add({
    ...payload,
    createdAt: nowTimestamp(),
  });
}

module.exports = async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      message: 'Method tidak diizinkan. Gunakan POST.',
    });
  }

  try {
    const firebaseAdmin = initFirebaseAdmin();
    const db = firebaseAdmin.firestore();
    const decodedToken = await verifyAuthToken(req, firebaseAdmin);
    const body = parseBody(req);

    const requestId = toText(body.requestId || body.orderId || body.id);
    const eventType = toText(body.eventType || body.type || 'new_order');

    if (!requestId) {
      return res.status(400).json({
        success: false,
        message: 'requestId wajib diisi.',
      });
    }

    const order = await getSparepartOrder(db, requestId);
    const orderData = order.data || {};
    const content = eventContent(eventType, orderData, requestId);

    const adminDocs = await getAdminDocs(db);
    const tokens = collectTokensFromDocs(adminDocs);

    const dataPayload = {
      requestId,
      orderId: requestId,
      collection: SPAREPART_ORDERS_COLLECTION,
      collectionName: SPAREPART_ORDERS_COLLECTION,
      sourceCollection: SPAREPART_ORDERS_COLLECTION,
      target: 'admin',
      role: 'admin',
      type: content.type,
      eventType,
      status: content.status,
      orderStatus: content.status,
      title: content.title,
      body: content.body,
      showPopup: content.showPopup,
      canAccept: 'false',
      action: content.action,
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
    };

    const notificationId = await saveNotificationDoc(db, {
      requestId,
      orderId: requestId,
      collection: SPAREPART_ORDERS_COLLECTION,
      collectionName: SPAREPART_ORDERS_COLLECTION,
      sourceCollection: SPAREPART_ORDERS_COLLECTION,
      target: 'admin',
      targetRole: 'admin',
      type: content.type,
      eventType,
      status: content.status,
      orderStatus: content.status,
      title: content.title,
      body: content.body,
      showPopup: content.showPopup === 'true',
      canAccept: false,
      action: content.action,
      createdByUid: decodedToken.uid,
    });

    const fcmResult = await sendMulticast(firebaseAdmin, tokens, {
      title: content.title,
      body: content.body,
      data: {
        ...dataPayload,
        notificationId,
      },
    });

    await order.ref.set(
      {
        lastAdminNotificationAt: nowTimestamp(),
        lastAdminNotificationType: content.type,
        lastAdminNotificationEventType: eventType,
        lastAdminNotificationFcmResult: fcmResult,
        updatedAt: nowTimestamp(),
      },
      { merge: true }
    );

    await saveNotificationLog(db, {
      requestId,
      orderId: requestId,
      collection: SPAREPART_ORDERS_COLLECTION,
      collectionName: SPAREPART_ORDERS_COLLECTION,
      target: 'admin',
      type: content.type,
      eventType,
      status: content.status,
      tokenCount: fcmResult.tokenCount,
      successCount: fcmResult.successCount,
      failureCount: fcmResult.failureCount,
      errors: fcmResult.errors,
      notificationId,
      createdByUid: decodedToken.uid,
    });

    return res.status(200).json({
      success: true,
      message: 'Notifikasi admin Sparepart berhasil diproses.',
      requestId,
      collection: SPAREPART_ORDERS_COLLECTION,
      target: 'admin',
      type: content.type,
      notificationId,
      recipientCount: adminDocs.length,
      fcmResult,
    });
  } catch (error) {
    console.error('send-sparepart-admin-notification error:', error);

    const message = error.message || 'Gagal mengirim notifikasi admin Sparepart.';
    const statusCode =
      message.includes('Authorization') || message.includes('Firebase ID token')
        ? 401
        : message.includes('wajib') ||
            message.includes('tidak valid') ||
            message.includes('tidak ditemukan')
          ? 400
          : 500;

    return res.status(statusCode).json({
      success: false,
      message,
    });
  }
};
