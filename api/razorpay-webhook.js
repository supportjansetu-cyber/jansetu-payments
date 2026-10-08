const crypto = require('crypto');
const Razorpay = require('razorpay');
const { applyPayment, PaymentApplyError } = require('../lib/apply-payment');

// Razorpay signs the exact bytes it sends, so the signature must be
// checked against the raw body. Vercel must not parse it first.
module.exports.config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function signatureMatches(rawBody, signature, secret) {
  if (!signature) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    console.error('razorpay-webhook: RAZORPAY_WEBHOOK_SECRET is not set');
    return res.status(500).json({ error: 'Webhook not configured' });
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    console.error('razorpay-webhook: could not read body:', err);
    return res.status(400).json({ error: 'Unreadable body' });
  }

  if (!signatureMatches(rawBody, req.headers['x-razorpay-signature'], secret)) {
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  // Only paid-order events matter. Acknowledge everything else with 200
  // so Razorpay doesn't keep retrying events we don't handle.
  if (event.event !== 'payment.captured' && event.event !== 'order.paid') {
    return res.status(200).json({ ignored: event.event });
  }

  const payment = event.payload?.payment?.entity;
  const paymentId = payment?.id;
  const orderId = payment?.order_id || event.payload?.order?.entity?.id;
  if (!paymentId || !orderId) {
    console.error('razorpay-webhook: event without payment/order id');
    return res.status(200).json({ ignored: 'missing ids' });
  }

  try {
    // Read what was bought from the order's notes, set server-side at
    // order creation. Never trust anything else in the payload.
    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
    const order = await razorpay.orders.fetch(orderId);

    const { alreadyApplied } = await applyPayment({
      paymentId,
      orderId,
      notes: order.notes,
    });
    return res.status(200).json({ success: true, alreadyApplied });
  } catch (err) {
    if (err instanceof PaymentApplyError) {
      // Bad metadata will never succeed on retry, so stop Razorpay
      // retrying, but leave a trail to investigate.
      console.error(
        `razorpay-webhook: cannot apply payment ${paymentId}: ${err.message}`,
      );
      return res.status(200).json({ ignored: err.message });
    }
    // Unexpected failure (Firestore or Razorpay down): 500 makes
    // Razorpay retry later.
    console.error('razorpay-webhook: failed:', err);
    return res.status(500).json({ error: 'Failed to apply payment' });
  }
};