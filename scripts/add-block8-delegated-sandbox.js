const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');
let source = fs.readFileSync(serverPath, 'utf8');

if (source.includes('BLOCK8_DELEGATED_SANDBOX_READY')) {
  console.log('Block 8 delegated sandbox already applied');
  process.exit(0);
}

const routeAnchor = "app.get('/api/payments/bookings/:id', auth, allow('user'), async (req, res, next) => {";
const anchorIndex = source.indexOf(routeAnchor);
if (anchorIndex < 0) throw new Error('Block 8 delegated sandbox patch failed: payment route anchor not found');

const delegated = String.raw`
// BLOCK8_DELEGATED_SANDBOX_READY
// Payment sandbox identity and booking authorization are delegated to the
// production booking API. The staging service never needs the production
// JWT secret or production database credentials.
const BLOCK8_BOOKING_SOURCE = String(process.env.BLOCK8_BOOKING_SOURCE_URL || 'https://skillhub-backend-b5iy.onrender.com').replace(/\/$/, '');

async function block8SourceBooking(req, bookingId) {
  const authorization = String(req.headers.authorization || '');
  if (!/^Bearer\s+\S+$/i.test(authorization)) {
    const error = new Error('Authentication required'); error.status = 401; throw error;
  }
  const response = await fetch(BLOCK8_BOOKING_SOURCE + '/api/bookings/me', {
    headers: { Authorization: authorization, Accept: 'application/json' }
  });
  const data = await response.json().catch(() => ([]));
  if (!response.ok) {
    const error = new Error(data?.error || 'No se pudo validar la sesión');
    error.status = response.status === 403 ? 403 : 401;
    throw error;
  }
  const rows = Array.isArray(data) ? data : (Array.isArray(data?.bookings) ? data.bookings : []);
  const booking = rows.find((item) => String(item?.id) === String(bookingId));
  if (!booking) { const error = new Error('Reserva no encontrada'); error.status = 404; throw error; }
  const perspective = String(booking.perspective || '').toLowerCase();
  if (perspective && perspective !== 'client') {
    const error = new Error('Solo el cliente de la reserva puede iniciar el pago'); error.status = 403; throw error;
  }
  const status = String(booking.status || '').toLowerCase();
  if (!['pending','confirmed'].includes(status)) {
    const error = new Error('Esta reserva ya no puede iniciar un pago'); error.status = 409; throw error;
  }
  const gross = Number(booking.total ?? booking.price ?? booking.agreedPrice ?? booking.agreed_price ?? 0);
  if (!Number.isFinite(gross) || gross <= 0) {
    const error = new Error('La reserva no tiene un total válido para cobrar'); error.status = 409; throw error;
  }
  const token = authorization.replace(/^Bearer\s+/i, '');
  const payload = jwt.decode(token) || {};
  const clientId = Number(payload.id || booking.clientId || booking.client_id || 0) || null;
  const providerId = Number(booking.providerId || booking.provider_id || (perspective === 'client' ? booking.otherUserId : 0) || 0) || null;
  return {
    id: Number(booking.id),
    clientId,
    providerId,
    serviceName: String(booking.serviceName || booking.service_name || 'Servicio Zeqviro').slice(0,120),
    gross,
    status
  };
}

async function block8EnsureSandboxTable() {
  await pool.query(\`
    CREATE TABLE IF NOT EXISTS block8_sandbox_payments (
      external_booking_id BIGINT PRIMARY KEY,
      source_client_id BIGINT,
      source_provider_id BIGINT,
      service_name TEXT NOT NULL DEFAULT 'Servicio Zeqviro',
      currency TEXT NOT NULL DEFAULT 'usd',
      gross_amount NUMERIC(10,2) NOT NULL CHECK (gross_amount >= 0),
      platform_fee NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (platform_fee >= 0),
      provider_amount NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (provider_amount >= 0),
      stripe_session_id TEXT NOT NULL DEFAULT '',
      stripe_payment_intent_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started','requires_payment','processing','paid','refunded','failed','cancelled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  \`);
}

app.get('/api/payments/bookings/:id', async (req, res, next) => {
  try {
    const booking = await block8SourceBooking(req, req.params.id);
    await block8EnsureSandboxTable();
    const { rows } = await pool.query(\`SELECT external_booking_id AS "bookingId",currency,gross_amount::float AS "grossAmount",
      platform_fee::float AS "platformFee",provider_amount::float AS "providerAmount",status,'test'::text AS mode,
      stripe_session_id AS "processorPaymentId",created_at AS "createdAt",updated_at AS "updatedAt"
      FROM block8_sandbox_payments WHERE external_booking_id=$1\`, [booking.id]);
    res.json({ bookingId: booking.id, serviceName: booking.serviceName, paymentStatus: rows[0]?.status || 'not_started', payment: rows[0] || null, testOnly: true });
  } catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); next(e); }
});

app.post('/api/payments/bookings/:id/prepare', async (req, res, next) => {
  try {
    const booking = await block8SourceBooking(req, req.params.id);
    await block8EnsureSandboxTable();
    const fee = Number((booking.gross * COMMISSION_RATE).toFixed(2));
    const providerAmount = Number((booking.gross - fee).toFixed(2));
    const { rows } = await pool.query(\`INSERT INTO block8_sandbox_payments(external_booking_id,source_client_id,source_provider_id,service_name,currency,gross_amount,platform_fee,provider_amount,status)
      VALUES($1,$2,$3,$4,'usd',$5,$6,$7,'requires_payment')
      ON CONFLICT (external_booking_id) DO UPDATE SET source_client_id=EXCLUDED.source_client_id,source_provider_id=EXCLUDED.source_provider_id,
        service_name=EXCLUDED.service_name,gross_amount=EXCLUDED.gross_amount,platform_fee=EXCLUDED.platform_fee,provider_amount=EXCLUDED.provider_amount,
        status=CASE WHEN block8_sandbox_payments.status IN ('paid','refunded') THEN block8_sandbox_payments.status ELSE 'requires_payment' END,updated_at=NOW()
      RETURNING external_booking_id AS "bookingId",currency,gross_amount::float AS "grossAmount",platform_fee::float AS "platformFee",
        provider_amount::float AS "providerAmount",status\`, [booking.id, booking.clientId, booking.providerId, booking.serviceName, booking.gross, fee, providerAmount]);
    res.json({ ...rows[0], serviceName: booking.serviceName, testOnly: true, processorReady: Boolean(stripeTestKey()) });
  } catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); next(e); }
});

app.post('/api/payments/bookings/:id/checkout-session', async (req, res, next) => {
  try {
    if (!stripeTestKey()) return res.status(503).json({ error: 'El checkout de prueba todavía no está configurado.' });
    const booking = await block8SourceBooking(req, req.params.id);
    await block8EnsureSandboxTable();
    const fee = Number((booking.gross * COMMISSION_RATE).toFixed(2));
    const providerAmount = Number((booking.gross - fee).toFixed(2));
    const params = new URLSearchParams();
    params.set('mode','payment');
    params.set('success_url', paymentReturnBase() + '/?payment=success&session_id={CHECKOUT_SESSION_ID}');
    params.set('cancel_url', paymentReturnBase() + '/?payment=cancelled');
    params.set('client_reference_id', String(booking.id));
    params.set('metadata[bookingId]', String(booking.id));
    params.set('metadata[source]', 'block8-delegated');
    if (booking.clientId) params.set('metadata[clientId]', String(booking.clientId));
    if (booking.providerId) params.set('metadata[providerId]', String(booking.providerId));
    params.set('payment_intent_data[metadata][bookingId]', String(booking.id));
    params.set('line_items[0][quantity]','1');
    params.set('line_items[0][price_data][currency]','usd');
    params.set('line_items[0][price_data][unit_amount]', String(Math.round(booking.gross * 100)));
    params.set('line_items[0][price_data][product_data][name]', booking.serviceName);
    const sessionData = await stripeRequest('checkout/sessions', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:params.toString() });
    await pool.query(\`INSERT INTO block8_sandbox_payments(external_booking_id,source_client_id,source_provider_id,service_name,currency,gross_amount,platform_fee,provider_amount,stripe_session_id,status)
      VALUES($1,$2,$3,$4,'usd',$5,$6,$7,$8,'requires_payment')
      ON CONFLICT (external_booking_id) DO UPDATE SET source_client_id=EXCLUDED.source_client_id,source_provider_id=EXCLUDED.source_provider_id,
        service_name=EXCLUDED.service_name,gross_amount=EXCLUDED.gross_amount,platform_fee=EXCLUDED.platform_fee,provider_amount=EXCLUDED.provider_amount,
        stripe_session_id=EXCLUDED.stripe_session_id,status=CASE WHEN block8_sandbox_payments.status='paid' THEN block8_sandbox_payments.status ELSE 'requires_payment' END,updated_at=NOW()\`,
      [booking.id, booking.clientId, booking.providerId, booking.serviceName, booking.gross, fee, providerAmount, sessionData.id]);
    res.json({ checkoutUrl: sessionData.url, sessionId: sessionData.id, testOnly: true, amount: booking.gross, currency:'usd' });
  } catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); if (e.code === 'STRIPE_NOT_CONFIGURED') return res.status(503).json({ error:'Stripe de prueba no está configurado.' }); next(e); }
});

app.post('/api/payments/stripe/confirm-session', async (req, res, next) => {
  try {
    const sessionId = String(req.body.sessionId || '').trim();
    if (!/^cs_test_/.test(sessionId)) return res.status(400).json({ error:'Sesión de pago de prueba inválida' });
    const sessionData = await stripeRequest('checkout/sessions/' + encodeURIComponent(sessionId));
    const bookingId = Number(sessionData?.metadata?.bookingId || sessionData?.client_reference_id || 0);
    if (!bookingId) return res.status(409).json({ error:'La sesión no está asociada a una reserva válida' });
    const booking = await block8SourceBooking(req, bookingId);
    await block8EnsureSandboxTable();
    const paid = sessionData.payment_status === 'paid' && sessionData.status === 'complete';
    const nextStatus = paid ? 'paid' : sessionData.status === 'expired' ? 'cancelled' : 'processing';
    await pool.query(\`UPDATE block8_sandbox_payments SET status=$1,stripe_session_id=$2,stripe_payment_intent_id=$3,updated_at=NOW() WHERE external_booking_id=$4\`,
      [nextStatus, sessionId, String(sessionData.payment_intent || ''), booking.id]);
    res.json({ bookingId: booking.id, status: nextStatus, paid, testOnly: true });
  } catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); if (e.code === 'STRIPE_NOT_CONFIGURED') return res.status(503).json({ error:'Stripe de prueba no está configurado.' }); next(e); }
});

`;

source = source.slice(0, anchorIndex) + delegated + source.slice(anchorIndex);
fs.writeFileSync(serverPath, source, 'utf8');
console.log('Block 8 delegated sandbox applied');
