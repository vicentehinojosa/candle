export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }

  const { product, amount, success_path } = req.body;

  if (!product || !amount || !success_path) {
    return res.status(400).json({ error: 'Missing product, amount, or success_path' });
  }

  try {
    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        'mode': 'payment',
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][product_data][name]': product,
        'line_items[0][price_data][unit_amount]': String(amount),
        'line_items[0][quantity]': '1',
        'success_url': `https://candle.codes${success_path}?session_id={CHECKOUT_SESSION_ID}`,
        'cancel_url': `https://candle.codes${success_path}`,
      }),
    });

    const session = await response.json();

    if (session.error) {
      return res.status(400).json({ error: session.error.message });
    }

    return res.status(200).json({ url: session.url });

  } catch (e) {
    return res.status(500).json({ error: 'Failed to create checkout session' });
  }
}
