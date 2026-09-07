const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');
let source = fs.readFileSync(serverPath, 'utf8');

function replaceOnce(needle, replacement, label) {
  if (source.includes(replacement)) return;
  if (!source.includes(needle)) throw new Error(`Block 8 webhook/refund patch failed: ${label}`);
  source = source.replace(needle, replacement);
}

replaceOnce(
  `app.use(express.json({ limit: '32kb' }));`,
  `app.post('/api/payments/stripe/webhook', express.raw({ type: 'application/json', limit: '256kb' }), stripeWebhookHandler);\napp.use(express.json({ limit: '32kb' }));`,
  'raw webhook route before json parser'
);

replaceOnce(
  `    CREATE TABLE IF NOT EXISTS email_verification_codes (`,
  `    CREATE TABLE IF NOT EXISTS payment_webhook_events (\n      event_id TEXT PRIMARY KEY,\n      event_type TEXT NOT NULL,\n      processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()\n    );\n    CREATE INDEX IF NOT EXISTS idx_payment_webhook_events_processed ON payment_webhook_events(processed_at DESC);\n    CREATE TABLE IF NOT EXISTS email_verification_codes (`,
  'webhook idempotency table'
);

const routes = `
function stripeWebhookSecret() {
  const value = String(process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  return value.startsWith('whsec_') ? value : '';
}

function verifyStripeSignature(rawBody, header) {
  const secret = stripeWebhookSecret();
  if (!secret || !Buffer.isBuffer(rawBody) || !header) return false;
  const parts = String(header).split(',').map(part => part.trim());
  const timestamp = parts.find(part => part.startsWith('t='))?.slice(2);
  const signatures = parts.filter(part => part.startsWith('v1=')).map(part => part.slice(3));
  if (!timestamp || !signatures.length) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) return false;
  const payload = timestamp + '.' + rawBody.toString('utf8');
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return signatures.some(sig => {
    try {
      return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch { return false; }
  });
}

async function applyStripeEvent(event) {
  const type = String(event?.type || '');
  const obj = event?.data?.object || {};
  let bookingId = Number(obj?.metadata?.bookingId || obj?.client_reference_id || 0);
  let nextStatus = '';
  let processorId = obj?.payment_intent || obj?.id || '';

  if (type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded') {
    if (obj.payment_status !== 'paid') return;
    nextStatus = 'paid';
  } else if (type === 'checkout.session.expired') {
    nextStatus = 'cancelled';
  } else if (type === 'payment_intent.payment_failed') {
    bookingId = Number(obj?.metadata?.bookingId || 0);
    nextStatus = 'failed';
    processorId = obj?.id || '';
  } else if (type === 'charge.refunded') {
    processorId = obj?.payment_intent || '';
    const { rows } = await pool.query('SELECT booking_id FROM payment_records WHERE processor_payment_id=$1 LIMIT 1', [processorId]);
    bookingId = Number(rows[0]?.booking_id || 0);
    nextStatus = 'refunded';
  } else {
    return;
  }

  if (!Number.isInteger(bookingId) || bookingId <= 0) return;
  await pool.query(\`UPDATE payment_records SET status=$1,processor_payment_id=CASE WHEN $2='' THEN processor_payment_id ELSE $2 END,updated_at=NOW() WHERE booking_id=$3\`,
    [nextStatus, processorId, bookingId]);
  await pool.query('UPDATE bookings SET payment_status=$1 WHERE id=$2', [nextStatus, bookingId]);
}

async function stripeWebhookHandler(req, res) {
  try {
    if (!stripeTestKey() || !stripeWebhookSecret()) return res.status(503).json({ error: 'Webhook de Stripe de prueba no configurado' });
    if (!verifyStripeSignature(req.body, req.headers['stripe-signature'])) return res.status(400).json({ error: 'Firma de webhook inválida' });
    const event = JSON.parse(req.body.toString('utf8'));
    if (!/^evt_/.test(String(event.id || ''))) return res.status(400).json({ error: 'Evento inválido' });
    const inserted = await pool.query(\`INSERT INTO payment_webhook_events(event_id,event_type) VALUES($1,$2) ON CONFLICT (event_id) DO NOTHING RETURNING event_id\`, [event.id, event.type || 'unknown']);
    if (!inserted.rows[0]) return res.json({ received: true, duplicate: true });
    try {
      await applyStripeEvent(event);
      return res.json({ received: true });
    } catch (e) {
      await pool.query('DELETE FROM payment_webhook_events WHERE event_id=$1', [event.id]);
      throw e;
    }
  } catch (e) {
    console.error('Stripe webhook error', e);
    return res.status(500).json({ error: 'No se pudo procesar el webhook' });
  }
}

app.post('/api/payments/bookings/:id/refund-test', auth, allow('user'), async (req, res, next) => {
  try {
    if (!stripeTestKey()) return res.status(503).json({ error: 'Stripe de prueba no está configurado.' });
    if (req.body?.confirm !== true) return res.status(400).json({ error: 'Confirma explícitamente el reembolso de prueba.' });
    const { rows } = await pool.query(\`SELECT b.id,b.client_id,b.payment_status,p.processor_payment_id,p.status AS record_status
      FROM bookings b LEFT JOIN payment_records p ON p.booking_id=b.id WHERE b.id=$1\`, [req.params.id]);
    const item = rows[0];
    if (!item) return res.status(404).json({ error: 'Reserva no encontrada' });
    if (String(item.client_id) !== String(req.user.id)) return res.status(403).json({ error: 'Solo el cliente puede solicitar este reembolso de prueba' });
    if (item.payment_status !== 'paid' || item.record_status !== 'paid') return res.status(409).json({ error: 'Solo se puede reembolsar un pago completado' });
    if (!/^pi_/.test(String(item.processor_payment_id || ''))) return res.status(409).json({ error: 'No se encontró el identificador del pago de Stripe' });

    const params = new URLSearchParams();
    params.set('payment_intent', item.processor_payment_id);
    params.set('metadata[bookingId]', String(item.id));
    const refund = await stripeRequest('refunds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const status = refund.status === 'succeeded' ? 'refunded' : 'processing';
    await pool.query('UPDATE payment_records SET status=$1,updated_at=NOW() WHERE booking_id=$2', [status, item.id]);
    await pool.query('UPDATE bookings SET payment_status=$1 WHERE id=$2', [status, item.id]);
    res.json({ bookingId: item.id, refundId: refund.id, status, testOnly: true });
  } catch (e) { next(e); }
});

app.get('/api/payments/bookings/:id/receipt', auth, allow('user'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(\`SELECT b.id,b.client_id,b.scheduled_at,b.payment_status,s.provider_id,s.name AS service_name,
      p.currency,p.gross_amount::float AS gross,p.platform_fee::float AS fee,p.provider_amount::float AS provider_amount,p.status,p.updated_at
      FROM bookings b JOIN services s ON s.id=b.service_id LEFT JOIN payment_records p ON p.booking_id=b.id WHERE b.id=$1\`, [req.params.id]);
    const item = rows[0];
    if (!item) return res.status(404).json({ error: 'Reserva no encontrada' });
    if (String(item.client_id) !== String(req.user.id) && String(item.provider_id) !== String(req.user.id)) return res.status(403).json({ error: 'No tienes acceso a este comprobante' });
    res.json({
      bookingId: item.id,
      serviceName: item.service_name,
      scheduledAt: item.scheduled_at,
      status: item.status || item.payment_status,
      currency: item.currency || 'usd',
      total: Number(item.gross || 0),
      platformFee: Number(item.fee || 0),
      providerAmount: Number(item.provider_amount || 0),
      updatedAt: item.updated_at || null,
      testOnly: true
    });
  } catch (e) { next(e); }
});

`;

replaceOnce(
  `app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));`,
  routes + `app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));`,
  'webhook refund receipt routes'
);

fs.writeFileSync(serverPath, source, 'utf8');
console.log('Block 8 Stripe webhook/refund/receipt applied');
