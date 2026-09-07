const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');
let source = fs.readFileSync(serverPath, 'utf8');

function replaceOnce(needle, replacement, label) {
  if (source.includes(replacement)) return;
  if (!source.includes(needle)) throw new Error(`Block 8 payments patch failed: ${label}`);
  source = source.replace(needle, replacement);
}

replaceOnce(
  `    CREATE TABLE IF NOT EXISTS email_verification_codes (`,
  `    CREATE TABLE IF NOT EXISTS payment_records (\n      id BIGSERIAL PRIMARY KEY,\n      booking_id BIGINT UNIQUE NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,\n      client_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,\n      provider_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,\n      processor TEXT NOT NULL DEFAULT 'none',\n      processor_payment_id TEXT NOT NULL DEFAULT '',\n      currency TEXT NOT NULL DEFAULT 'usd',\n      gross_amount NUMERIC(10,2) NOT NULL CHECK (gross_amount >= 0),\n      platform_fee NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (platform_fee >= 0),\n      provider_amount NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (provider_amount >= 0),\n      status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started','requires_payment','processing','paid','refunded','failed','cancelled')),\n      mode TEXT NOT NULL DEFAULT 'test' CHECK (mode IN ('test','live')),\n      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),\n      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()\n    );\n    CREATE INDEX IF NOT EXISTS idx_payment_records_status_created ON payment_records(status, created_at DESC);\n    CREATE INDEX IF NOT EXISTS idx_payment_records_provider_created ON payment_records(provider_id, created_at DESC);\n    CREATE TABLE IF NOT EXISTS email_verification_codes (`,
  'payment records table'
);

replaceOnce(
  `app.get('/api/payments/config', (_req, res) => {\n  res.json({\n    enabled: false,\n    mode: 'test_only',\n    currency: 'usd',\n    commissionRate: COMMISSION_RATE,\n    message: 'Los pagos reales todavía no están activados.'\n  });\n});`,
  `app.get('/api/payments/config', (_req, res) => {\n  res.json({\n    enabled: false,\n    mode: 'test_only',\n    currency: 'usd',\n    commissionRate: COMMISSION_RATE,\n    foundationReady: true,\n    processor: 'not_configured',\n    message: 'La base de pagos está preparada en modo de prueba. Los pagos reales siguen desactivados.'\n  });\n});`,
  'payment config metadata'
);

const routes = `
app.get('/api/payments/bookings/:id', auth, allow('user'), async (req, res, next) => {
  try {
    const { rows: bookingRows } = await pool.query(\`SELECT b.id,b.client_id,b.total,b.payment_status,s.provider_id,s.name AS service_name
      FROM bookings b JOIN services s ON s.id=b.service_id WHERE b.id=$1\`, [req.params.id]);
    const booking = bookingRows[0];
    if (!booking) return res.status(404).json({ error: 'Reserva no encontrada' });
    const allowed = String(booking.client_id) === String(req.user.id) || String(booking.provider_id) === String(req.user.id);
    if (!allowed) return res.status(403).json({ error: 'No tienes acceso a esta reserva' });
    const { rows } = await pool.query(\`SELECT id,booking_id AS "bookingId",processor,processor_payment_id AS "processorPaymentId",currency,
      gross_amount::float AS "grossAmount",platform_fee::float AS "platformFee",provider_amount::float AS "providerAmount",status,mode,
      created_at AS "createdAt",updated_at AS "updatedAt" FROM payment_records WHERE booking_id=$1\`, [booking.id]);
    res.json({ bookingId: booking.id, serviceName: booking.service_name, paymentStatus: booking.payment_status, payment: rows[0] || null });
  } catch (e) { next(e); }
});

app.post('/api/payments/bookings/:id/prepare', auth, allow('user'), async (req, res, next) => {
  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(\`SELECT b.id,b.client_id,b.total,b.status,s.provider_id,s.name AS service_name
        FROM bookings b JOIN services s ON s.id=b.service_id WHERE b.id=$1 FOR UPDATE\`, [req.params.id]);
      const booking = rows[0];
      if (!booking) return { missing: true };
      if (String(booking.client_id) !== String(req.user.id)) return { forbidden: true };
      if (!['pending','confirmed'].includes(booking.status)) return { unavailable: true };
      const gross = Number(booking.total || 0);
      const fee = Number((gross * COMMISSION_RATE).toFixed(2));
      const providerAmount = Number((gross - fee).toFixed(2));
      const { rows: paymentRows } = await client.query(\`INSERT INTO payment_records(booking_id,client_id,provider_id,processor,currency,gross_amount,platform_fee,provider_amount,status,mode)
        VALUES($1,$2,$3,'none','usd',$4,$5,$6,'requires_payment','test')
        ON CONFLICT (booking_id) DO UPDATE SET gross_amount=EXCLUDED.gross_amount,platform_fee=EXCLUDED.platform_fee,
          provider_amount=EXCLUDED.provider_amount,status=CASE WHEN payment_records.status IN ('paid','refunded') THEN payment_records.status ELSE 'requires_payment' END,
          updated_at=NOW()
        RETURNING id,booking_id AS "bookingId",currency,gross_amount::float AS "grossAmount",platform_fee::float AS "platformFee",
          provider_amount::float AS "providerAmount",status,mode\`, [booking.id, booking.client_id, booking.provider_id, gross, fee, providerAmount]);
      await client.query(\`UPDATE bookings SET payment_status=$1,platform_fee=$2,provider_amount=$3 WHERE id=$4\`,
        [paymentRows[0].status, fee, providerAmount, booking.id]);
      return { payment: paymentRows[0], serviceName: booking.service_name };
    });
    if (result.missing) return res.status(404).json({ error: 'Reserva no encontrada' });
    if (result.forbidden) return res.status(403).json({ error: 'Solo el cliente de la reserva puede preparar el pago' });
    if (result.unavailable) return res.status(409).json({ error: 'Esta reserva ya no puede iniciar un pago' });
    res.json({ ...result.payment, serviceName: result.serviceName, testOnly: true, processorReady: false });
  } catch (e) { next(e); }
});

`;

replaceOnce(
  `app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));`,
  routes + `app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));`,
  'payment foundation routes'
);

fs.writeFileSync(serverPath, source, 'utf8');
console.log('Block 8 payments foundation applied');
