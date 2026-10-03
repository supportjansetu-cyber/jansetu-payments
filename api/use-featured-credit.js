const admin = require('firebase-admin');

// Initialize the Firebase Admin SDK once per cold start (same as
// verify-payment.js).
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();

// Only these collections can be featured. Each has a postedBy field that
// must match the caller.
const FEATURABLE_COLLECTIONS = ['gigs', 'workers', 'local_businesses'];

// Thrown inside the transaction to return a clean HTTP error to the app.
class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // --- Who is calling? Never trust a uid sent in the body: verify the ---
  // --- caller's Firebase ID token and take the uid from that instead. ---
  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) {
    return res.status(401).json({ error: 'Missing sign-in token', code: 'unauthenticated' });
  }

  let uid;
  try {
    const decoded = await admin.auth().verifyIdToken(match[1]);
    uid = decoded.uid;
  } catch (err) {
    console.error('use-featured-credit: token verification failed:', err);
    return res.status(401).json({ error: 'Invalid sign-in token', code: 'unauthenticated' });
  }

  const { entityCollection, entityId } = req.body || {};

  if (!FEATURABLE_COLLECTIONS.includes(entityCollection)) {
    return res.status(400).json({ error: 'Invalid entityCollection', code: 'bad_request' });
  }
  if (
    typeof entityId !== 'string' ||
    entityId.length === 0 ||
    entityId.length > 200 ||
    entityId.includes('/')
  ) {
    return res.status(400).json({ error: 'Invalid entityId', code: 'bad_request' });
  }

  const userRef = db.collection('users').doc(uid);
  const entityRef = db.collection(entityCollection).doc(entityId);

  try {
    const remaining = await db.runTransaction(async (tx) => {
      // All reads first, then writes.
      const userSnap = await tx.get(userRef);
      const entitySnap = await tx.get(entityRef);

      if (!entitySnap.exists) {
        // The listing may not have synced from the phone yet; the app
        // retries on this code. No credit has been spent.
        throw new HttpError(404, 'not_found', 'Listing not found');
      }
      const entity = entitySnap.data();

      if (entity.postedBy !== uid) {
        throw new HttpError(403, 'not_owner', 'You can only feature your own listing');
      }
      if (entity.isFeatured === true) {
        throw new HttpError(409, 'already_featured', 'Listing is already featured');
      }

      const user = userSnap.exists ? userSnap.data() : {};
      const proUntilMs =
        user.proUntil && typeof user.proUntil.toMillis === 'function'
          ? user.proUntil.toMillis()
          : 0;
      if (proUntilMs <= Date.now()) {
        throw new HttpError(403, 'not_pro', 'Your Pro plan is not active');
      }

      const credits = typeof user.featuredCredits === 'number' ? user.featuredCredits : 0;
      if (credits < 1) {
        throw new HttpError(402, 'no_credits', 'No free Featured listings left');
      }

      tx.update(userRef, { featuredCredits: admin.firestore.FieldValue.increment(-1) });
      tx.update(entityRef, { isFeatured: true });
      return credits - 1;
    });

    return res.status(200).json({ success: true, remaining });
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error('use-featured-credit: unexpected error:', err);
    return res.status(500).json({ error: 'Could not apply credit', code: 'server_error' });
  }
};