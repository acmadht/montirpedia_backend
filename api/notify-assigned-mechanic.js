const admin = require('firebase-admin');

function initFirebaseAdmin() {
  if (admin.apps.length > 0) {
    return admin;
  }

  let serviceAccount;

  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    const decoded = Buffer.from(
      process.env.FIREBASE_SERVICE_ACCOUNT_BASE64,
      'base64'
    ).toString('utf8');

    serviceAccount = JSON.parse(decoded);
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  } else {
    serviceAccount = require('../serviceAccountKey.json');
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  return admin;
}

async function collectMechanicTokens(db, mechanicId) {
  const tokens = [];

  const userDoc = await db.collection('users').doc(mechanicId).get();

  if (!userDoc.exists) {
    console.log(`Mechanic user ${mechanicId} tidak ditemukan`);
    return tokens;
  }

  const userData = userDoc.data() || {};

  if (typeof userData.fcmToken === 'string' && userData.fcmToken.trim()) {
    tokens.push(userData.fcmToken.trim());
  }

  if (Array.isArray(userData.fcmTokens)) {
    for (const token of userData.fcmTokens) {
      if (typeof token === 'string' && token.trim()) {
        tokens.push(token.trim());
      }
    }
  }

  return [...new Set(tokens)];
}

async function collectCustomerTokens(db, customerId) {
  const tokens = [];

  const userDoc = await db.collection('users').doc(customerId).get();

  if (!userDoc.exists) {
    console.log(`Customer user ${customerId} tidak ditemukan`);
    return tokens;
  }

  const userData = userDoc.data() || {};

  if (typeof userData.fcmToken === 'string' && userData.fcmToken.trim()) {
    tokens.push(userData.fcmToken.trim());
  }

  if (Array.isArray(userData.fcmTokens)) {
    for (const token of userData.fcmTokens) {
      if (typeof token === 'string' && token.trim()) {
        tokens.push(token.trim());
      }
    }
  }

  return [...new Set(tokens)];
}

async function sendFcmNotifications(tokens, title, body, data = {}) {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    console.log('Tokens kosong, skip notifikasi FCM');
    return { successCount: 0, failureCount: 0 };
  }

  const uniqueTokens = [...new Set(tokens)].slice(0, 500);

  const message = {
    tokens: uniqueTokens,
    notification: {
      title,
      body,
    },
    data: {
      ...data,
      requestId: data.requestId || '',
    },
    android: {
      priority: 'high',
      notification: {
        channelId: 'montirpedia_order_channel',
        sound: 'default',
        priority: 'high',
        defaultSound: true,
        defaultVibrateTimings: true,
      },
    },
  };

  const response = await admin.messaging().sendEachForMulticast(message);
  return response;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      message: 'Method tidak diizinkan. Gunakan POST.',
    });
  }

  try {
    const adminApp = initFirebaseAdmin();
    const db = adminApp.firestore();

    const { requestId, assignedMechanicId, customerUid } = req.body || {};

    if (!requestId || typeof requestId !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'requestId wajib diisi.',
      });
    }

    if (!assignedMechanicId || typeof assignedMechanicId !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'assignedMechanicId wajib diisi.',
      });
    }

    if (!customerUid || typeof customerUid !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'customerUid wajib diisi.',
      });
    }

    // Ambil data order
    const requestDoc = await db.collection('service_requests').doc(requestId).get();

    if (!requestDoc.exists) {
      return res.status(404).json({
        success: false,
        message: 'Service request tidak ditemukan.',
      });
    }

    const requestData = requestDoc.data() || {};
    const customerName = requestData.customerName || requestData.nama || 'Customer';
    const vehicleName = requestData.vehicleName || requestData.kendaraan || '-';
    const serviceName = requestData.serviceName || requestData.layanan || 'Servis';

    // Ambil data mekanik
    const mechanicDoc = await db.collection('users').doc(assignedMechanicId).get();
    const mechanicName = mechanicDoc.exists
      ? mechanicDoc.data()?.name || mechanicDoc.data()?.nama || 'Montir'
      : 'Montir';

    // Kirim notifikasi ke mekanik yang ditugaskan
    const mechanicTokens = await collectMechanicTokens(db, assignedMechanicId);

    if (mechanicTokens.length > 0) {
      await sendFcmNotifications(
        mechanicTokens,
        'Order Baru Untuk Anda!',
        `${customerName} dengan kendaraan ${vehicleName} meminta layanan ${serviceName}. Cek detail order sekarang.`,
        {
          requestId,
          type: 'mechanic_assigned_new_order',
          target: 'mechanic',
        }
      );

      console.log(
        `Notifikasi terkirim ke mekanik ${assignedMechanicId} untuk order ${requestId}`
      );
    }

    // Kirim notifikasi ke customer
    const customerTokens = await collectCustomerTokens(db, customerUid);

    if (customerTokens.length > 0) {
      await sendFcmNotifications(
        customerTokens,
        'Montir Ditugaskan!',
        `Order Anda sudah ditugaskan ke mekanik ${mechanicName}. Montir akan segera menghubungi Anda.`,
        {
          requestId,
          type: 'customer_mechanic_assigned',
          target: 'customer',
        }
      );

      console.log(`Notifikasi terkirim ke customer ${customerUid} untuk order ${requestId}`);
    }

    return res.status(200).json({
      success: true,
      message: 'Notifikasi assignment mekanik berhasil dikirim.',
      requestId,
      mechanicId: assignedMechanicId,
      mechanicName,
      customerId: customerUid,
      customerName,
    });
  } catch (error) {
    console.error('notify-assigned-mechanic error:', error);

    return res.status(500).json({
      success: false,
      message: error.message || 'Gagal mengirim notifikasi assignment.',
    });
  }
};
