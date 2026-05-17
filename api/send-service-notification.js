const admin = require('firebase-admin');

const SERVICE_COLLECTION = process.env.SERVICE_COLLECTION || 'service_requests';
const USERS_COLLECTION = process.env.USERS_COLLECTION || 'users';
const NOTIFICATIONS_COLLECTION = process.env.NOTIFICATIONS_COLLECTION || 'notifications';
const NOTIFICATION_LOGS_COLLECTION = process.env.NOTIFICATION_LOGS_COLLECTION || 'notification_logs';

const NEARBY_RADIUS_KM = Number(process.env.NEARBY_MECHANIC_RADIUS_KM || 25);
const NEARBY_LIMIT = Number(process.env.NEARBY_MECHANIC_LIMIT || 10);

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

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nowTimestamp() {
  return admin.firestore.FieldValue.serverTimestamp();
}

function normalizeRole(value) {
  const role = toText(value).toLowerCase();

  if (role === 'montir' || role === 'mekanik' || role === 'mechanic') {
    return 'mechanic';
  }

  if (role === 'superadmin' || role === 'super_admin') {
    return 'admin';
  }

  return role;
}

function normalizeTarget(value) {
  const target = normalizeRole(value);

  if (target === 'mechanic') return 'mechanic';
  if (target === 'admin') return 'admin';
  if (target === 'customer') return 'customer';

  return target || 'mechanic';
}

function normalizeType(value, target) {
  const type = toText(value).toLowerCase();

  if (type) return type;
  if (target === 'admin') return 'admin_new_service_request';

  return 'new_service_request';
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

async function getUserDocByIdOrUid(db, userId) {
  const cleanId = toText(userId);
  if (!cleanId) return null;

  const directDoc = await db.collection(USERS_COLLECTION).doc(cleanId).get();
  if (directDoc.exists) return directDoc;

  const querySnap = await db
    .collection(USERS_COLLECTION)
    .where('uid', '==', cleanId)
    .limit(1)
    .get();

  if (!querySnap.empty) return querySnap.docs[0];

  return null;
}

async function getServiceRequest(db, requestId) {
  const collectionRef = db.collection(SERVICE_COLLECTION);

  const candidates = Array.from(new Set([
    requestId,
    requestId.replace(/^SR-/, ''),
    requestId.replace(/^SB-/, ''),
    requestId.replace(/^SERVICE-/, ''),
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

  const fields = ['requestId', 'orderId', 'id', 'bookingId'];

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

  throw new Error(`Data service_requests tidak ditemukan. requestId=${requestId}`);
}

function readCustomerName(orderData) {
  return toText(
    orderData.customerName ||
      orderData['Nama pelanggan'] ||
      orderData.nama ||
      orderData.name,
    'Customer'
  );
}

function readServiceName(orderData) {
  return toText(
    orderData.serviceName ||
      orderData.layanan ||
      orderData.jenisLayanan ||
      orderData.service,
    'Home Service'
  );
}

function readLatLng(data) {
  const lat = toNumber(
    data.lat ?? data.latitude ?? data.currentLat ?? data.customerLat ?? data.mechanicLat,
    NaN
  );
  const lng = toNumber(
    data.lng ?? data.longitude ?? data.currentLng ?? data.customerLng ?? data.mechanicLng,
    NaN
  );

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;

  return { lat, lng };
}

function distanceKm(aLat, aLng, bLat, bLng) {
  const earthRadiusKm = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const lat1 = (aLat * Math.PI) / 180;
  const lat2 = (bLat * Math.PI) / 180;

  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);

  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));

  return earthRadiusKm * c;
}

function isMechanicAvailable(userData) {
  const role = normalizeRole(userData.role || userData.userRole || userData.accountType);

  if (role !== 'mechanic') return false;

  const disabled = userData.disabled === true || userData.isDisabled === true || userData.blocked === true;
  if (disabled) return false;

  const availabilityRaw = toText(
    userData.availabilityStatus ||
      userData.onlineStatus ||
      userData.status ||
      userData.mechanicStatus
  ).toLowerCase();

  if (!availabilityRaw) return true;

  const unavailableValues = new Set([
    'offline',
    'tidak aktif',
    'nonaktif',
    'sibuk',
    'busy',
    'unavailable',
    'tidak tersedia',
  ]);

  return !unavailableValues.has(availabilityRaw);
}

async function getMechanicDocs(db) {
  const usersRef = db.collection(USERS_COLLECTION);
  const docMap = new Map();
  const roleValues = ['mechanic', 'mekanik', 'montir'];

  for (const role of roleValues) {
    try {
      const snap = await usersRef.where('role', '==', role).get();
      snap.docs.forEach((doc) => docMap.set(doc.id, doc));
    } catch (error) {
      console.error(`Query mechanic role ${role} gagal:`, error.message);
    }
  }

  try {
    const snap = await usersRef.where('isMechanic', '==', true).get();
    snap.docs.forEach((doc) => docMap.set(doc.id, doc));
  } catch (error) {
    console.error('Query isMechanic gagal:', error.message);
  }

  return Array.from(docMap.values());
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
    console.error('Query isAdmin gagal:', error.message);
  }

  return Array.from(docMap.values());
}

async function getNearbyMechanicDocs(db, orderData) {
  const customerLocation = readLatLng({
    customerLat: orderData.customerLat,
    customerLng: orderData.customerLng,
  });

  const allMechanicDocs = await getMechanicDocs(db);
  const availableMechanics = [];

  for (const doc of allMechanicDocs) {
    const userData = doc.data() || {};

    if (!isMechanicAvailable(userData)) continue;

    const tokens = readTokensFromUserData(userData);
    if (tokens.length === 0) continue;

    const mechanicLocation = readLatLng(userData);

    let distance = 0;
    let hasDistance = false;

    if (customerLocation && mechanicLocation) {
      distance = distanceKm(
        customerLocation.lat,
        customerLocation.lng,
        mechanicLocation.lat,
        mechanicLocation.lng
      );
      hasDistance = true;

      if (distance > NEARBY_RADIUS_KM) continue;
    }

    availableMechanics.push({
      doc,
      data: userData,
      distance,
      hasDistance,
    });
  }

  availableMechanics.sort((a, b) => {
    if (a.hasDistance && b.hasDistance) return a.distance - b.distance;
    if (a.hasDistance) return -1;
    if (b.hasDistance) return 1;
    return 0;
  });

  return availableMechanics.slice(0, NEARBY_LIMIT).map((item) => item.doc);
}

function collectTokensFromDocs(docs) {
  const tokens = new Set();

  docs.forEach((doc) => {
    readTokensFromUserData(doc.data() || {}).forEach((token) => tokens.add(token));
  });

  return Array.from(tokens);
}

function buildContent({ target, type, orderData, requestId }) {
  const customerName = readCustomerName(orderData);
  const serviceName = readServiceName(orderData);

  if (target === 'admin') {
    return {
      title: 'Order Home Service Baru',
      body: `${customerName} mengirim order ${serviceName}.`,
      type: type || 'admin_new_service_request',
    };
  }

  if (type === 'assigned_mechanic') {
    return {
      title: 'Order Ditugaskan ke Kamu',
      body: `${customerName} membutuhkan ${serviceName}. Tap untuk menerima pesanan.`,
      type,
    };
  }

  return {
    title: 'Order Home Service Baru',
    body: `${customerName} membutuhkan ${serviceName}. Tap untuk menerima pesanan.`,
    type: type || 'new_service_request',
  };
}

function buildNotificationData({
  requestId,
  target,
  type,
  title,
  body,
  showPopup,
  canAccept,
  action,
  assignedMechanicId,
}) {
  return {
    requestId,
    orderId: requestId,
    collection: SERVICE_COLLECTION,
    collectionName: SERVICE_COLLECTION,
    sourceCollection: SERVICE_COLLECTION,
    target,
    role: target,
    type,
    status: 'unread',
    title,
    body,
    showPopup: showPopup ? 'true' : 'false',
    canAccept: canAccept ? 'true' : 'false',
    action,
    assignedMechanicId: toText(assignedMechanicId),
    click_action: 'FLUTTER_NOTIFICATION_CLICK',
  };
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
        channelId: 'montirpedia_order_sound_v2',
        sound: 'montirpedia_alert',
        priority: 'high',
        defaultSound: false,
        defaultVibrateTimings: true,
      },
    },
    apns: {
      payload: {
        aps: {
          sound: 'montirpedia_alert.wav',
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
    collection: SERVICE_COLLECTION,
    collectionName: SERVICE_COLLECTION,
    sourceCollection: SERVICE_COLLECTION,
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

async function resolveRecipients({ db, target, body, orderData }) {
  if (target === 'admin') {
    const adminDocs = await getAdminDocs(db);
    return {
      recipientDocs: adminDocs,
      mode: 'admin_info',
      assignedMechanicId: '',
    };
  }

  const explicitMechanicId =
    toText(body.assignedMechanicId) ||
    toText(body.mechanicId) ||
    toText(body.mechanicUid) ||
    toText(orderData.assignedMechanicId) ||
    toText(orderData.mechanicId) ||
    toText(orderData.mechanicUid);

  if (explicitMechanicId) {
    const mechanicDoc = await getUserDocByIdOrUid(db, explicitMechanicId);

    if (!mechanicDoc || !mechanicDoc.exists) {
      return {
        recipientDocs: [],
        mode: 'assigned_mechanic_not_found',
        assignedMechanicId: explicitMechanicId,
      };
    }

    return {
      recipientDocs: [mechanicDoc],
      mode: 'assigned_mechanic',
      assignedMechanicId: explicitMechanicId,
    };
  }

  const nearbyDocs = await getNearbyMechanicDocs(db, orderData);

  return {
    recipientDocs: nearbyDocs,
    mode: 'nearby_mechanics',
    assignedMechanicId: '',
  };
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
    const target = normalizeTarget(body.target || body.role);
    const type = normalizeType(body.type, target);

    if (!requestId) {
      return res.status(400).json({
        success: false,
        message: 'requestId wajib diisi.',
      });
    }

    if (target !== 'mechanic' && target !== 'admin') {
      return res.status(400).json({
        success: false,
        message: 'target tidak valid. Gunakan mechanic atau admin.',
      });
    }

    const serviceRequest = await getServiceRequest(db, requestId);
    const orderData = serviceRequest.data || {};

    const recipients = await resolveRecipients({
      db,
      target,
      body,
      orderData,
    });

    const recipientTokens = collectTokensFromDocs(recipients.recipientDocs);
    const content = buildContent({
      target,
      type,
      orderData,
      requestId,
    });

    const isMechanicTarget = target === 'mechanic';
    const showPopup = isMechanicTarget;
    const canAccept = isMechanicTarget;
    const action = isMechanicTarget
      ? 'open_accept_order_popup'
      : 'open_admin_notification';

    const dataPayload = buildNotificationData({
      requestId,
      target,
      type: content.type,
      title: content.title,
      body: content.body,
      showPopup,
      canAccept,
      action,
      assignedMechanicId: recipients.assignedMechanicId,
    });

    const notificationId = await saveNotificationDoc(db, {
      requestId,
      orderId: requestId,
      target,
      targetRole: target,
      targetUserId: recipients.assignedMechanicId,
      recipientMode: recipients.mode,
      recipientCount: recipients.recipientDocs.length,
      type: content.type,
      status: 'unread',
      title: content.title,
      body: content.body,
      showPopup,
      canAccept,
      action,
      createdByUid: decodedToken.uid,
    });

    const fcmResult = await sendMulticast(firebaseAdmin, recipientTokens, {
      title: content.title,
      body: content.body,
      data: {
        ...dataPayload,
        notificationId,
      },
    });

    await serviceRequest.ref.set(
      {
        collection: SERVICE_COLLECTION,
        collectionName: SERVICE_COLLECTION,
        sourceCollection: SERVICE_COLLECTION,
        lastNotificationAt: nowTimestamp(),
        lastNotificationTarget: target,
        lastNotificationType: content.type,
        lastNotificationRecipientMode: recipients.mode,
        lastNotificationFcmResult: fcmResult,
        updatedAt: nowTimestamp(),
      },
      { merge: true }
    );

    await saveNotificationLog(db, {
      requestId,
      orderId: requestId,
      collection: SERVICE_COLLECTION,
      collectionName: SERVICE_COLLECTION,
      target,
      type: content.type,
      recipientMode: recipients.mode,
      recipientCount: recipients.recipientDocs.length,
      tokenCount: fcmResult.tokenCount,
      successCount: fcmResult.successCount,
      failureCount: fcmResult.failureCount,
      errors: fcmResult.errors,
      notificationId,
      createdByUid: decodedToken.uid,
    });

    return res.status(200).json({
      success: true,
      message: target === 'admin'
        ? 'Notifikasi admin berhasil diproses.'
        : 'Notifikasi montir berhasil diproses.',
      requestId,
      collection: SERVICE_COLLECTION,
      target,
      type: content.type,
      notificationId,
      recipientMode: recipients.mode,
      recipientCount: recipients.recipientDocs.length,
      fcmResult,
    });
  } catch (error) {
    console.error('send-service-notification error:', error);

    const message = error.message || 'Gagal mengirim notifikasi Home Service.';
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
