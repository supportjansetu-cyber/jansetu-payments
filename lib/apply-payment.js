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

// Collections a Featured purchase may target.
const FEATURABLE_COLLECTIONS = ['gigs', 'workers', 'local_businesses'];

/// Thrown for problems with the order itself (bad metadata, unknown
/// product). Callers turn it into an HTTP status; anything else that
/// throws is an unexpected failure.
class PaymentApplyError extends Error {
  constructor(message, httpStatus) {
    super(message);
    this.httpStatus = httpStatus;
  }
}

/// Grants what a paid Razorpay order bought. Safe to call more than once
/// for the same payment (the app's verify call and the webhook can both
/// report it): the processedPayments record, checked inside a
/// transaction, makes every call after the first a no-op.
///
/// [notes] is the order's notes object, as stored at order creation.
/// Returns { alreadyApplied }.
async function applyPayment({ paymentId, orderId, notes }) {
  const { uid, productType, entityCollection, entityId } = notes || {};

  if (!uid || !productType) {
    throw new PaymentApplyError('Order is missing required metadata', 400);
  }

  // One doc per payment. Clients can never read or write this collection
  // (default-deny rules; the Admin SDK bypasses rules).
  const paymentRef = db.collection('processedPayments').doc(paymentId);
  const subscription = SUBSCRIPTION_PLANS[productType];

  if (subscription) {
    const userRef = db.collection('users').doc(uid);
    let alreadyApplied = false;

    await db.runTransaction(async (tx) => {
      const paymentSnap = await tx.get(paymentRef);
      if (paymentSnap.exists) {
        alreadyApplied = true;
        return;
      }

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
        orderId,
        appliedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    return { alreadyApplied };
  }

  if (productType === 'featured_listing') {
    if (!entityCollection || !entityId) {
      throw new PaymentApplyError('Missing listing to feature', 400);
    }
    if (!FEATURABLE_COLLECTIONS.includes(entityCollection)) {
      throw new PaymentApplyError('Invalid listing collection', 400);
    }

    const entityRef = db.collection(entityCollection).doc(entityId);
    let alreadyApplied = false;

    await db.runTransaction(async (tx) => {
      const paymentSnap = await tx.get(paymentRef);
      if (paymentSnap.exists) {
        alreadyApplied = true;
        return;
      }

      const entitySnap = await tx.get(entityRef);
      const record = {
        uid,
        productType,
        orderId,
        entityCollection,
        entityId,
        appliedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      if (entitySnap.exists) {
        tx.update(entityRef, { isFeatured: true });
      } else {
        // The listing is gone (deleted before the payment landed). Do not
        // create a stub document - other phones would pull it. Record the
        // payment so it can be found and refunded by hand.
        console.error(
          `applyPayment: listing ${entityCollection}/${entityId} missing for payment ${paymentId}`,
        );
        record.listingMissing = true;
      }
      tx.set(paymentRef, record);
    });

    return { alreadyApplied };
  }

  throw new PaymentApplyError('Unknown productType', 400);
}

module.exports = { applyPayment, PaymentApplyError };