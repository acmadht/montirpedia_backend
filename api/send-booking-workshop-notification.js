const admin = require('firebase-admin');

const USERS_COLLECTION = process.env.USERS_COLLECTION || 'users';
const BOOKING_COLLECTION =
  process.env.BOOKING_COLLECTION || 'booking_jadwal';
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
    throw new Error(
      'Firebase service account belum diset di Environment Variables Vercel.'
    );
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

async function getBookingOrder(db, requestId) {
  const collectionRef = db.collection(BOOKING_COLLECTION);
  const candidates = Array.from(
    new Set(
      [
        requestId,
        requestId.replace(/^BK-/, ''),
        requestId.replace(/^BOOKING-/, ''),
        requestId.replace(/^ORDER-/, ''),
      ]
        .map((item) => toText(item))
        .filter(Boolean)
    )
  );

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
      const querySnap = await collectionRef
        .where(field, '==', id)
        .limit(1)
        .get();

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

  throw new Error(`Data ${BOOKING_COLLECTION} tidak ditemukan. requestId=${requestId}`);
}

function readCustomerName(orderData) {
  return toText(orderData.customerName || orderData.nama || orderData.name, 'Customer');
}

function readWorkshopName(orderData) {
  return toText(
    orderData.workshopName ||
      orderData.namaBengkel ||
      orderData.bengkelName ||
      orderData.nama_bengkel,
    'Bengkel'
  );
}

function readVehicleLabel(orderData) {
  const vehicleType = toText(
    orderData.vehicleType || orderData.jenisKendaraan || orderData.jenis_kendaraan,
    ''
  );
  const vehicleName = toText(
    orderData.vehicleName || orderData.kendaraan || orderData.namaKendaraan,
    ''
  );

  if (vehicleType && vehicleName) return `${vehicleType} • ${vehicleName}`;
  if (vehicleName) return vehicleName;
  if (vehicleType) return vehicleType;

  return 'Kendaraan';
}

function readBookingTime(orderData) {
  const dateText = toText(orderData.tanggalBookingText || orderData.bookingDateText, '');
  const timeText = toText(orderData.jamBooking || orderData.bookingTime, '');

  if (dateText && timeText) return `${dateText} pukul ${timeText}`;
  if (dateText) return dateText;
  if (timeText) return `pukul ${timeText}`;

  const rawTimestamp = orderData.tanggalBooking || orderData.bookingDateTime;

  if (rawTimestamp && typeof rawTimestamp.toDate === 'function') {
    const date = rawTimestamp.toDate();
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    const hour = String(date.getHours()).padStart(2, '0');
    const minute = String(date.getMinutes()).padStart(2, '0');

    return `${day}-${month}-${year} pukul ${hour}:${minute}`;
  }

  return 'jadwal yang dipilih';
}

function eventContent(eventType, orderData, requestId) {
  const event = cleanKey(eventType || 'booking_new_order');
  const customerName = readCustomerName(orderData);
  const workshopName = readWorkshopName(orderData);
  const vehicleLabel = readVehicleLabel(orderData);
  const bookingTime = readBookingTime(orderData);

  if (
    event === 'new_order' ||
    event === 'booking_new_order' ||
    event === 'workshop_booking_new_order'
  ) {
    return {
      title: 'Booking Jadwal Baru',
      body: `${customerName} membuat booking ${vehicleLabel} di ${workshopName}, ${bookingTime}.`,
      type: 'workshop_booking_new_order',
      status: 'waiting_workshop_confirmation',
      action: 'open_workshop_booking',
      showPopup: 'true',
      target: 'bengkel',
      targetRole: 'bengkel',
    };
  }

  if (
    event === 'booking_confirmed' ||
    event === 'confirmed' ||
    event === 'dikonfirmasi_bengkel'
  ) {
    return {
      title: 'Booking Dikonfirmasi Bengkel',
      body: `${workshopName} mengonfirmasi booking ${customerName} untuk ${bookingTime}.`,
      type: 'customer_booking_confirmed',
      status: 'confirmed_by_workshop',
      action: 'open_customer_order_status',
      showPopup: 'false',
      target: 'customer',
      targetRole: 'customer',
    };
  }

  if (event === 'status_update' || event === 'status_changed') {
    const statusLabel = toText(
      orderData.statusOrder || orderData.status || orderData.orderStatus,
      'Status diperbarui'
    );

    return {
      title: 'Status Booking Berubah',
      body: `Booking ${requestId} berubah menjadi ${statusLabel}.`,
      type: 'booking_status_update',
      status: statusLabel,
      action: 'open_customer_order_status',
      showPopup: 'false',
      target: 'customer',
      targetRole: 'customer',
    };
  }

  if (event === 'cancelled' || event === 'canceled' || event === 'dibatalkan') {
    return {
      title: 'Booking Dibatalkan',
      body: `Booking ${requestId} telah dibatalkan.`,
      type: 'booking_cancelled',
      status: 'cancelled',
      action: 'open_customer_order_status',
      showPopup: 'false',
      target: 'customer',
      targetRole: 'customer',
    };
  }

  return {
    title: 'Update Booking Jadwal',
    body: `Ada update baru untuk booking ${requestId}.`,
    type: 'booking_update',
    status: event,
    action: 'open_customer_order_status',
    showPopup: 'false',
    target: 'customer',
    targetRole: 'customer',
  };
}

function collectUniqueIds(values) {
  return Array.from(
    new Set(
      values
        .map((value) => toText(value))
        .filter(Boolean)
        .filter((value) => value !== '-' && value.toLowerCase() !== 'null')
    )
  );
}

async function getDocsByIds(db, ids) {
  const usersRef = db.collection(USERS_COLLECTION);
  const docMap = new Map();

  for (const id of ids) {
    try {
      const docSnap = await usersRef.doc(id).get();

      if (docSnap.exists) {
        docMap.set(docSnap.id, docSnap);
      }
    } catch (error) {
      console.error(`Ambil user ${id} gagal:`, error.message);
    }
  }

  return Array.from(docMap.values());
}

async function queryUsersByFieldValues(db, fieldNames, values) {
  const usersRef = db.collection(USERS_COLLECTION);
  const docMap = new Map();

  for (const fieldName of fieldNames) {
    for (const value of values) {
      try {
        const snap = await usersRef.where(fieldName, '==', value).limit(20).get();
        snap.docs.forEach((doc) => docMap.set(doc.id, doc));
      } catch (error) {
        console.error(`Query users ${fieldName}=${value} gagal:`, error.message);
      }
    }
  }

  return Array.from(docMap.values());
}

async function getWorkshopDocs(db, orderData) {
  const ids = collectUniqueIds([
    orderData.targetUid,
    orderData.bengkelOwnerUid,
    orderData.workshopOwnerUid,
    orderData.ownerUid,
    orderData.ownerId,
    orderData.bengkelId,
    orderData.workshopId,
  ]);

  const docsById = await getDocsByIds(db, ids);

  const queryFields = [
    'uid',
    'bengkelId',
    'workshopId',
    'ownerUid',
    'bengkelOwnerUid',
    'workshopOwnerUid',
  ];

  const queriedDocs = await queryUsersByFieldValues(db, queryFields, ids);
  const docMap = new Map();

  [...docsById, ...queriedDocs].forEach((doc) => {
    const data = doc.data() || {};
    const role = toText(data.role || data.userRole || '').toLowerCase();
    const isWorkshop =
      data.isBengkel === true ||
      data.isWorkshop === true ||
      role === 'bengkel' ||
      role === 'workshop' ||
      role === 'admin_bengkel' ||
      role === 'mitra_bengkel';

    if (isWorkshop || ids.includes(doc.id)) {
      docMap.set(doc.id, doc);
    }
  });

  return Array.from(docMap.values());
}

async function getCustomerDocs(db, orderData) {
  const ids = collectUniqueIds([
    orderData.customerUid,
    orderData.customerId,
    orderData.userId,
    orderData.createdByUid,
    orderData.uid,
  ]);

  return getDocsByIds(db, ids);
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

function targetKindFromRequest(body, content) {
  const target = cleanKey(body.target || body.targetRole || content.target || content.targetRole);

  if (target === 'admin') return 'admin';
  if (target === 'customer' || target === 'pelanggan') return 'customer';
  if (target === 'workshop' || target === 'bengkel') return 'bengkel';

  return content.targetRole || 'bengkel';
}

async function getTargetDocs(db, targetKind, orderData) {
  if (targetKind === 'admin') return getAdminDocs(db);
  if (targetKind === 'customer') return getCustomerDocs(db, orderData);

  return getWorkshopDocs(db, orderData);
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
    const eventType = toText(body.eventType || body.type || 'booking_new_order');

    if (!requestId) {
      return res.status(400).json({
        success: false,
        message: 'requestId wajib diisi.',
      });
    }

    const booking = await getBookingOrder(db, requestId);
    const orderData = booking.data || {};
    const content = eventContent(eventType, orderData, requestId);
    const targetKind = targetKindFromRequest(body, content);

    const targetDocs = await getTargetDocs(db, targetKind, orderData);
    const tokens = collectTokensFromDocs(targetDocs);

    const dataPayload = {
      requestId,
      orderId: requestId,
      collection: BOOKING_COLLECTION,
      collectionName: BOOKING_COLLECTION,
      sourceCollection: BOOKING_COLLECTION,
      target: targetKind,
      targetRole: targetKind,
      type: content.type,
      eventType,
      status: content.status,
      orderStatus: content.status,
      title: content.title,
      body: content.body,
      showPopup: content.showPopup,
      action: content.action,
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
    };

    const notificationId = await saveNotificationDoc(db, {
      requestId,
      orderId: requestId,
      collection: BOOKING_COLLECTION,
      collectionName: BOOKING_COLLECTION,
      sourceCollection: BOOKING_COLLECTION,
      target: targetKind,
      targetRole: targetKind,
      type: content.type,
      eventType,
      status: content.status,
      orderStatus: content.status,
      title: content.title,
      body: content.body,
      showPopup: content.showPopup === 'true',
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

    const updatePayload = {
      lastBookingNotificationAt: nowTimestamp(),
      lastBookingNotificationType: content.type,
      lastBookingNotificationEventType: eventType,
      lastBookingNotificationTarget: targetKind,
      lastBookingNotificationFcmResult: fcmResult,
      updatedAt: nowTimestamp(),
    };

    if (targetKind === 'bengkel') {
      updatePayload.lastBengkelNotificationAt = nowTimestamp();
      updatePayload.lastWorkshopNotificationAt = nowTimestamp();
    }

    if (targetKind === 'customer') {
      updatePayload.lastCustomerNotificationAt = nowTimestamp();
    }

    if (targetKind === 'admin') {
      updatePayload.lastAdminNotificationAt = nowTimestamp();
    }

    await booking.ref.set(updatePayload, { merge: true });

    await saveNotificationLog(db, {
      requestId,
      orderId: requestId,
      collection: BOOKING_COLLECTION,
      collectionName: BOOKING_COLLECTION,
      target: targetKind,
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
      message: 'Notifikasi Booking Jadwal berhasil diproses.',
      requestId,
      collection: BOOKING_COLLECTION,
      target: targetKind,
      type: content.type,
      notificationId,
      recipientCount: targetDocs.length,
      fcmResult,
    });
  } catch (error) {
    console.error('send-booking-workshop-notification error:', error);

    const message = error.message || 'Gagal mengirim notifikasi Booking Jadwal.';
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
