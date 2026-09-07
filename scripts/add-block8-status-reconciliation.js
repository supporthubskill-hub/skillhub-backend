const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');
let source = fs.readFileSync(serverPath, 'utf8');

if (source.includes('BLOCK8_STATUS_RECONCILIATION_READY')) {
  console.log('Block 8 status reconciliation already applied');
  process.exit(0);
}

const anchor = "app.get('/api/payments/bookings/:id', async (req, res, next) => {";
const idx = source.indexOf(anchor);
if (idx < 0) throw new Error('Block 8 reconciliation patch failed: delegated payment GET route not found');

const route = `// BLOCK8_STATUS_RECONCILIATION_READY\napp.get('/api/payments/bookings/:id', async (req, res, next) => {\n  try {\n    const booking = await block8SourceBooking(req, req.params.id);\n    await block8EnsureSandboxTable();\n    let { rows } = await pool.query(\`SELECT external_booking_id AS "bookingId",currency,gross_amount::float AS "grossAmount",\n      platform_fee::float AS "platformFee",provider_amount::float AS "providerAmount",status,'test'::text AS mode,\n      stripe_session_id AS "processorPaymentId",created_at AS "createdAt",updated_at AS "updatedAt"\n      FROM block8_sandbox_payments WHERE external_booking_id=$1\`, [booking.id]);\n    let payment = rows[0] || null;\n    if (payment && !['paid','refunded'].includes(String(payment.status)) && /^cs_test_/.test(String(payment.processorPaymentId || ''))) {\n      try {\n        const sessionData = await stripeRequest('checkout/sessions/' + encodeURIComponent(payment.processorPaymentId));\n        const reconciled = sessionData.payment_status === 'paid' && sessionData.status === 'complete'\n          ? 'paid'\n          : sessionData.status === 'expired' ? 'cancelled' : String(payment.status || 'processing');\n        if (reconciled !== payment.status) {\n          await pool.query(\`UPDATE block8_sandbox_payments SET status=$1,stripe_payment_intent_id=$2,updated_at=NOW() WHERE external_booking_id=$3\`,\n            [reconciled, String(sessionData.payment_intent || ''), booking.id]);\n          payment.status = reconciled;\n        }\n      } catch (stripeError) {\n        console.warn('Block 8 status reconciliation skipped:', stripeError.message);\n      }\n    }\n    res.json({ bookingId: booking.id, serviceName: booking.serviceName, paymentStatus: payment?.status || 'not_started', payment, testOnly: true });\n  } catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); next(e); }\n});\n\n`;

source = source.slice(0, idx) + route + source.slice(idx);
fs.writeFileSync(serverPath, source, 'utf8');
console.log('Block 8 status reconciliation applied');
