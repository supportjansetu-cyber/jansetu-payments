const Razorpay = require('razorpay');

// Amounts here are hardcoded server-side on purpose — never trust an
// amount sent from the app, or anyone could pay less than the real price.
const PRICES = {
  featured_listing: 4900, // in paise: ₹49.00
  subscription_pro_monthly: 19900, // in paise: ₹199.00
  subscription_pro_yearly: 149900, // in paise: ₹1,499.00
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

  const { productType, uid, entityCollection, entityId } = req.body || {};

  if (!productType || !PRICES[productType]) {
    return res.status(400).json({ error: 'Invalid or missing productType' });
  }
  if (!uid) {
    return res.status(400).json({ error: 'Missing uid' });
  }
  if (productType === 'featured_listing' && (!entityCollection || !entityId)) {
    return res.status(400).json({ error: 'Missing entityCollection or entityId for featured listing' });
  }

  const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });

  try {
    const order = await razorpay.orders.create({
      amount: PRICES[productType],
      currency: 'INR',
      notes: {
        uid,
        productType,
        ...(productType === 'featured_listing' ? { entityCollection, entityId } : {}),
      },
    });

    return res.status(200).json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error('create-order error:', err);
    return res.status(500).json({ error: 'Failed to create order' });
  }
};