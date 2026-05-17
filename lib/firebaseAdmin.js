const admin = require('firebase-admin');

function parseServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8');
    return JSON.parse(decoded);
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }

  if (
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY
  ) {
    return {
      project_id: process.env.FIREBASE_PROJECT_ID,
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    };
  }

  return null;
}

function initFirebaseAdmin() {
  if (admin.apps.length) return admin;

  const serviceAccount = parseServiceAccount();

  if (serviceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    return admin;
  }

  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });

  return admin;
}

function getDb() {
  return initFirebaseAdmin().firestore();
}

async function verifyFirebaseTokenFromRequest(req) {
  const requireAuth = String(process.env.REQUIRE_FIREBASE_AUTH || 'false').toLowerCase() === 'true';
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  const token = String(authHeader).startsWith('Bearer ')
    ? String(authHeader).slice('Bearer '.length).trim()
    : '';

  if (!token) {
    if (requireAuth) {
      throw new Error('Authorization token Firebase tidak ditemukan.');
    }

    return null;
  }

  try {
    const app = initFirebaseAdmin();
    return await app.auth().verifyIdToken(token);
  } catch (error) {
    if (requireAuth) {
      throw new Error(`Token Firebase tidak valid: ${error.message}`);
    }

    return null;
  }
}

module.exports = {
  admin,
  initFirebaseAdmin,
  getDb,
  verifyFirebaseTokenFromRequest,
};
