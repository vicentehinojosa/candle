export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { session_id } = req.body;
  if (!session_id) {
    return res.status(400).json({ valid: false, error: 'No session ID provided' });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return res.status(500).json({ valid: false, error: 'Stripe not configured' });
  }

  try {
    const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${session_id}`, {
      headers: {
        'Authorization': `Bearer ${stripeKey}`,
      },
    });

    const session = await response.json();

    if (session.error) {
      return res.status(400).json({ valid: false, error: 'Invalid session' });
    }

    if (session.payment_status !== 'paid') {
      return res.status(400).json({ valid: false, error: 'Payment not completed' });
    }

    return res.status(200).json({ valid: true });

  } catch (e) {
    return res.status(500).json({ valid: false, error: 'Verification failed' });
  }
}
