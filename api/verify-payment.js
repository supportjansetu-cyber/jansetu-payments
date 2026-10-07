const crypto = require('crypto');
const Razorpay = require('razorpay');
const admin = require('firebase-admin');

// Initialize the Firebase Admin SDK once per cold start, using the
// service account JSON stored as a Vercel environment variable (never
// committed to Git, never sent to the client).
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();

const DAY_MS = 24 * 60 * 60 * 1000;

// Free Featured listings granted with each yearly purchase. Spent through
// api/use-featured-credit.js, only while the Pro plan is active.
const YEARLY_FEATURED_CREDITS = 3;

// How long each subscription product lasts. Keep in sync with PRICES in
// create-order.js.
const SUBSCRIPTION_PLANS = {
  subscription_pro_monthly: { plan: 'monthly', days: 30, featuredCredits: 0 },
  subscription_pro_yearly: {
    plan: 'yearly',
    days: 365,
    featuredCredits: YEARLY_FEATURED_CREDITS,
  },
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
  } = req.body || {};

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing payment verification fields' });
  }

  // --- Step 1: verify the signature. This is the core security check ---
  // Razorpay signs order_id + "|" + payment_id with your Key Secret. If
  // the signature we compute doesn't match what was sent, either the
  // payment didn't really happen or someone is trying to fake this call.
  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expectedSignature !== razorpay_signature) {
    return res.status(400).json({ error: 'Invalid payment signature' });
  }

  // --- Step 2: fetch the order back from Razorpay to see what was ---
  // --- actually purchased. Never trust productType/uid if sent again ---
  // --- from the client at this stage - use what we stored at order ---
  // --- creation time instead. ---
  const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });

  let order;
  try {
    order = await razorpay.orders.fetch(razorpay_order_id);
  } catch (err) {
    console.error('verify-payment: order fetch failed:', err);
    return res.status(500).json({ error: 'Could not verify order' });
  }

  const { uid, productType, entityCollection, entityId } = order.notes || {};

  if (!uid || !productType) {
    return res.status(400).json({ error: 'Order is missing required metadata' });
  }

  // --- Step 3: grant the entitlement in Firestore ---
  try {
    const subscription = SUBSCRIPTION_PLANS[productType];

    if (subscription) {
      const userRef = db.collection('users').doc(uid);
      // One doc per payment, used to make this endpoint idempotent: if the
      // app retries verification for the same payment, we must not extend
      // the user's Pro period (or grant credits) a second time. Clients can
      // never read or write this collection (no rule matches it, so it is
      // default-deny; the Admin SDK bypasses rules).
      const paymentRef = db.collection('processedPayments').doc(razorpay_payment_id);

      await db.runTransaction(async (tx) => {
        const paymentSnap = await tx.get(paymentRef);
        if (paymentSnap.exists) return; // already applied

        const userSnap = await tx.get(userRef);
        const current = userSnap.exists ? userSnap.data() : {};

        const now = Date.now();
        const currentUntilMs =
          current.proUntil && typeof current.proUntil.toMillis === 'function'
            ? current.proUntil.toMillis()
            : 0;
        const stillActive = currentUntilMs > now;

        // Renewing while still Pro stacks onto the existing end date
        // instead of throwing away the time already paid for.
        const startMs = stillActive ? currentUntilMs : now;
        const newUntil = admin.firestore.Timestamp.fromMillis(
          startMs + subscription.days * DAY_MS,
        );

        // A user who is still on a yearly plan keeps the 'yearly' label
        // even if they top up with a monthly purchase.
        const newPlan =
          stillActive && current.subscriptionPlan === 'yearly'
            ? 'yearly'
            : subscription.plan;

        const update = {
          subscriptionTier: 'pro',
          // Kept for any old reader of this field. The app now checks
          // proUntil instead.
          isPremium: true,
          subscriptionPlan: newPlan,
          proUntil: newUntil,
        };

        // Yearly purchases add free Featured credits on top of whatever
        // the user has left.
        if (subscription.featuredCredits > 0) {
          update.featuredCredits = admin.firestore.FieldValue.increment(
            subscription.featuredCredits,
          );
        }

        tx.set(userRef, update, { merge: true });
        tx.set(paymentRef, {
          uid,
          productType,
          orderId: razorpay_order_id,
          appliedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });
    } else if (productType === 'featured_listing') {
      if (!entityCollection || !entityId) {
        return res.status(400).json({ error: 'Missing listing to feature' });
      }
      await db.collection(entityCollection).doc(entityId).set(
        { isFeatured: true },
        { merge: true },
      );
    } else {
      return res.status(400).json({ error: 'Unknown productType' });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('verify-payment: Firestore write failed:', err);
    return res.status(500).json({ error: 'Payment verified but failed to apply' });
  }
};
