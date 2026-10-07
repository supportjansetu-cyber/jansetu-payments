const crypto = require('crypto');
const Razorpay = require('razorpay');
const { applyPayment, PaymentApplyError } = require('../lib/apply-payment');

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

  // --- Step 3: grant the entitlement (shared with the webhook) ---
  try {
    await applyPayment({
      paymentId: razorpay_payment_id,
      orderId: razorpay_order_id,
      notes: order.notes,
    });
    return res.status(200).json({ success: true });
  } catch (err) {
    if (err instanceof PaymentApplyError) {
      return res.status(err.httpStatus).json({ error: err.message });
    }
    console.error('verify-payment: Firestore write failed:', err);
    return res.status(500).json({ error: 'Payment verified but failed to apply' });
  }
};