const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');
let source = fs.readFileSync(serverPath, 'utf8');

function replaceOnce(needle, replacement, label) {
  if (source.includes(replacement)) return;
  if (!source.includes(needle)) throw new Error(`Block 8 Stripe patch failed: ${label}`);
  source = source.replace(needle, replacement);
}

replaceOnce(
  `app.get('/api/payments/config', (_req, res) => {\n  res.json({\n    enabled: false,\n    mode: 'test_only',\n    currency: 'usd',\n    commissionRate: COMMISSION_RATE,\n    foundationReady: true,\n    processor: 'not_configured',\n    message: 'La base de pagos está preparada en modo de prueba. Los pagos reales siguen desactivados.'\n  });\n});`,
  `app.get('/api/payments/config', (_req, res) => {\n  const key = String(process.env.STRIPE_SECRET_KEY || '');\n  const testConfigured = key.startsWith('sk_test_');\n  res.json({\n    enabled: false,\n    mode: 'test_only',\n    currency: 'usd',\n    commissionRate: COMMISSION_RATE,\n    foundationReady: true,\n    processor: 'stripe',\n    processorConfigured: testConfigured,\n    checkoutReady: testConfigured,\n    message: testConfigured ? 'Stripe está conectado en modo de prueba. Los pagos reales siguen desactivados.' : 'Añade una clave de prueba de Stripe para habilitar el checkout de prueba.'\n  });\n});`,
  'payment config Stripe metadata'
);

const routes = `
function stripeTestKey() {
  const key = String(process.env.STRIPE_SECRET_KEY || '').trim();
  return key.startsWith('sk_test_') ? key : '';
}

function paymentReturnBase() {
  const configured = String(process.env.PAYMENT_RETURN_URL || '').trim();
  if (configured) return configured.replace(/\\/$/, '');
  const firstFrontend = String(process.env.FRONTEND_URL || '').split(',').map(v => v.trim()).find(Boolean);
  return (firstFrontend || 'http://localhost:3000').replace(/\\/$/, '');
}

async function stripeRequest(pathname, options = {}) {
  const key = stripeTestKey();
  if (!key) {
    const error = new Error('Stripe test mode is not configured');
    error.code = 'STRIPE_NOT_CONFIGURED';
    throw error;
  }
  const response = await fetch(\`https://api.stripe.com/v1/\${pathname}\`, {
    ...options,
    headers: {
      Authorization: \`Bearer \${key}\`,
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error?.message || 'Stripe request failed');
    error.status = response.status;
    throw error;
  }
  return data;
}

app.post('/api/payments/bookings/:id/checkout-session', auth, allow('user'), async (req, res, next) => {
  try {
    if (!stripeTestKey()) return res.status(503).json({ error: 'El checkout de prueba todavía no está configurado.' });
    const { rows } = await pool.query(\`SELECT b.id,b.client_id,b.total,b.status,b.payment_status,s.provider_id,s.name AS service_name
      FROM bookings b JOIN services s ON s.id=b.service_id WHERE b.id=$1\`, [req.params.id]);
    const booking = rows[0];
    if (!booking) return res.status(404).json({ error: 'Reserva no encontrada' });
    if (String(booking.client_id) !== String(req.user.id)) return res.status(403).json({ error: 'Solo el cliente puede iniciar el pago' });
    if (!['pending','confirmed'].includes(booking.status)) return res.status(409).json({ error: 'Esta reserva ya no puede pagarse' });
    if (booking.payment_status === 'paid') return res.status(409).json({ error: 'Esta reserva ya está pagada' });

    const gross = Number(booking.total || 0);
    if (!Number.isFinite(gross) || gross <= 0) return res.status(409).json({ error: 'La reserva no tiene un total válido para cobrar' });
    const fee = Number((gross * COMMISSION_RATE).toFixed(2));
    const providerAmount = Number((gross - fee).toFixed(2));

    const params = new URLSearchParams();
    params.set('mode', 'payment');
    params.set('success_url', \`\${paymentReturnBase()}/?payment=success&session_id={CHECKOUT_SESSION_ID}\`);
    params.set('cancel_url', \`\${paymentReturnBase()}/?payment=cancelled\`);
    params.set('client_reference_id', String(booking.id));
    params.set('metadata[bookingId]', String(booking.id));
    params.set('metadata[clientId]', String(booking.client_id));
    params.set('metadata[providerId]', String(booking.provider_id));
    params.set('payment_intent_data[metadata][bookingId]', String(booking.id));
    params.set('line_items[0][quantity]', '1');
    params.set('line_items[0][price_data][currency]', 'usd');
    params.set('line_items[0][price_data][unit_amount]', String(Math.round(gross * 100)));
    params.set('line_items[0][price_data][product_data][name]', String(booking.service_name || 'Servicio Zeqviro').slice(0, 120));

    const sessionData = await stripeRequest('checkout/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    await pool.query(\`INSERT INTO payment_records(booking_id,client_id,provider_id,processor,processor_payment_id,currency,gross_amount,platform_fee,provider_amount,status,mode)
      VALUES($1,$2,$3,'stripe',$4,'usd',$5,$6,$7,'requires_payment','test')
      ON CONFLICT (booking_id) DO UPDATE SET processor='stripe',processor_payment_id=EXCLUDED.processor_payment_id,
        gross_amount=EXCLUDED.gross_amount,platform_fee=EXCLUDED.platform_fee,provider_amount=EXCLUDED.provider_amount,
        status=CASE WHEN payment_records.status='paid' THEN payment_records.status ELSE 'requires_payment' END,mode='test',updated_at=NOW()\`,
      [booking.id, booking.client_id, booking.provider_id, sessionData.id, gross, fee, providerAmount]);
    await pool.query('UPDATE bookings SET payment_status=$1,platform_fee=$2,provider_amount=$3 WHERE id=$4 AND payment_status<>$5',
      ['requires_payment', fee, providerAmount, booking.id, 'paid']);

    res.json({ checkoutUrl: sessionData.url, sessionId: sessionData.id, testOnly: true, amount: gross, currency: 'usd' });
  } catch (e) {
    if (e.code === 'STRIPE_NOT_CONFIGURED') return res.status(503).json({ error: 'El checkout de prueba todavía no está configurado.' });
    next(e);
  }
});

app.post('/api/payments/stripe/confirm-session', auth, allow('user'), async (req, res, next) => {
  try {
    const sessionId = String(req.body.sessionId || '').trim();
    if (!/^cs_test_/.test(sessionId)) return res.status(400).json({ error: 'Sesión de pago de prueba inválida' });
    const sessionData = await stripeRequest(\`checkout/sessions/\${encodeURIComponent(sessionId)}\`);
    const bookingId = Number(sessionData?.metadata?.bookingId || sessionData?.client_reference_id || 0);
    if (!Number.isInteger(bookingId) || bookingId <= 0) return res.status(409).json({ error: 'La sesión no está asociada a una reserva válida' });
    const { rows } = await pool.query('SELECT id,client_id FROM bookings WHERE id=$1', [bookingId]);
    if (!rows[0]) return res.status(404).json({ error: 'Reserva no encontrada' });
    if (String(rows[0].client_id) !== String(req.user.id)) return res.status(403).json({ error: 'No tienes acceso a este pago' });

    const paid = sessionData.payment_status === 'paid' && sessionData.status === 'complete';
    const nextStatus = paid ? 'paid' : sessionData.status === 'expired' ? 'cancelled' : 'processing';
    await pool.query(\`UPDATE payment_records SET status=$1,processor_payment_id=$2,updated_at=NOW() WHERE booking_id=$3\`,
      [nextStatus, sessionData.payment_intent || sessionId, bookingId]);
    await pool.query('UPDATE bookings SET payment_status=$1 WHERE id=$2', [nextStatus, bookingId]);
    res.json({ bookingId, status: nextStatus, paid, testOnly: true });
  } catch (e) {
    if (e.code === 'STRIPE_NOT_CONFIGURED') return res.status(503).json({ error: 'Stripe de prueba no está configurado.' });
    next(e);
  }
});

`;

replaceOnce(
  `app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));`,
  routes + `app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));`,
  'Stripe test checkout routes'
);

fs.writeFileSync(serverPath, source, 'utf8');
console.log('Block 8 Stripe test checkout applied');
