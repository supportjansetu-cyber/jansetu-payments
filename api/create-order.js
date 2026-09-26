const Razorpay = require('razorpay');

// Amounts here are hardcoded server-side on purpose — never trust an
// amount sent from the app, or anyone could pay ₹1 for a ₹49 feature.
const PRICES = {
  featured_listing: 4900, // in paise: ₹49.00
  subscription_pro: 9900, // in paise: ₹99.00 (adjust to your real price)
};

module.exports = async (req, res) => {
  // Basic CORS so your Flutter app (or any client) can call this.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { productType, uid } = req.body || {};

  if (!productType || !PRICES[productType]) {
    return res.status(400).json({ error: 'Invalid or missing productType' });
  }
  if (!uid) {
    return res.status(400).json({ error: 'Missing uid' });
  }

  const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });

  try {
    const order = await razorpay.orders.create({
      amount: PRICES[productType],
      currency: 'INR',
      // notes travel with the order and come back in the webhook/verify
      // step, so we know what was actually purchased without trusting
      // anything the client claims at verification time.
      notes: {
        uid,
        productType,
      },
    });

    return res.status(200).json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID, // safe to expose - it's public
    });
  } catch (err) {
    console.error('create-order error:', err);
    return res.status(500).json({ error: 'Failed to create order' });
  }
};