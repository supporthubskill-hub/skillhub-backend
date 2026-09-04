const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');
let source = fs.readFileSync(serverPath, 'utf8');

function replaceOrThrow(needle, replacement, label) {
  if (!source.includes(needle)) throw new Error(`Rejection controls patch failed: ${label}`);
  source = source.replace(needle, replacement);
}

replaceOrThrow(
  "    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS provider_amount NUMERIC(10,2) NOT NULL DEFAULT 0;",
  "    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS provider_amount NUMERIC(10,2) NOT NULL DEFAULT 0;\n    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS rejection_reason TEXT NOT NULL DEFAULT '';\n    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;\n    CREATE TABLE IF NOT EXISTS service_request_blocks (\n      service_id BIGINT NOT NULL REFERENCES services(id) ON DELETE CASCADE,\n      client_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,\n      provider_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,\n      reason TEXT NOT NULL DEFAULT '',\n      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),\n      PRIMARY KEY(service_id, client_id)\n    );\n    CREATE INDEX IF NOT EXISTS idx_service_request_blocks_provider ON service_request_blocks(provider_id, created_at DESC);",
  'schema'
);

replaceOrThrow(
  "    if (String(services[0].provider_id) === String(req.user.id)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'No puedes reservar tu propio servicio' }); }",
  "    if (String(services[0].provider_id) === String(req.user.id)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'No puedes reservar tu propio servicio' }); }\n    const { rows: blockedRows } = await client.query('SELECT 1 FROM service_request_blocks WHERE service_id=$1 AND client_id=$2', [services[0].id, req.user.id]);\n    if (blockedRows[0]) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Este proveedor no acepta nuevas solicitudes tuyas para este servicio.' }); }\n    const { rows: recentRejectedRows } = await client.query(`SELECT rejected_at FROM bookings\n      WHERE service_id=$1 AND client_id=$2 AND status='rejected' AND rejected_at > NOW() - INTERVAL '30 minutes'\n      ORDER BY rejected_at DESC LIMIT 1`, [services[0].id, req.user.id]);\n    if (recentRejectedRows[0]) { await client.query('ROLLBACK'); return res.status(429).json({ error: 'Espera 30 minutos antes de enviar otra solicitud para este servicio.' }); }",
  'booking guards'
);

replaceOrThrow(
  "    const status = String(req.body.status || '');\n    if (!['confirmed','rejected','cancelled','completed'].includes(status))",
  "    const status = String(req.body.status || '');\n    const rejectionReason = String(req.body.reason || '').trim().slice(0, 300);\n    const blockFutureRequests = req.body.blockFutureRequests === true;\n    if (status === 'rejected' && rejectionReason.length < 3) return res.status(400).json({ error: 'Indica el motivo del rechazo.' });\n    if (!['confirmed','rejected','cancelled','completed'].includes(status))",
  'rejection input'
);

replaceOrThrow(
  "    if (!allowedTransitions[booking.status]?.includes(status)) return res.status(409).json({ error: 'Transición de estado no permitida' });\n    const updatedBooking = await withTransaction(async (client) => {\n      const { rows: updated } = await client.query('UPDATE bookings SET status=$1 WHERE id=$2 RETURNING id,status', [status, booking.id]);",
  "    if (!allowedTransitions[booking.status]?.includes(status)) return res.status(409).json({ error: 'Transición de estado no permitida' });\n    if (status === 'completed' && new Date(booking.scheduled_at).getTime() > Date.now()) return res.status(409).json({ error: 'No puedes marcar esta reserva como completada antes de la fecha y hora programadas.' });\n    const updatedBooking = await withTransaction(async (client) => {\n      const { rows: updated } = await client.query(`UPDATE bookings SET status=$1,\n        rejection_reason=CASE WHEN $1='rejected' THEN $3 ELSE rejection_reason END,\n        rejected_at=CASE WHEN $1='rejected' THEN NOW() ELSE rejected_at END\n        WHERE id=$2 RETURNING id,status,rejection_reason AS \"rejectionReason\",rejected_at AS \"rejectedAt\"`, [status, booking.id, rejectionReason]);\n      if (status === 'rejected' && blockFutureRequests) {\n        await client.query(`INSERT INTO service_request_blocks(service_id,client_id,provider_id,reason)\n          VALUES($1,$2,$3,$4)\n          ON CONFLICT(service_id,client_id) DO UPDATE SET reason=EXCLUDED.reason,created_at=NOW()`,\n          [booking.service_id, booking.client_id, booking.provider_id, rejectionReason]);\n      }",
  'rejection storage and completion guard'
);

replaceOrThrow(
  "      b.provider_amount::float AS \"providerAmount\",s.name AS \"serviceName\",",
  "      b.provider_amount::float AS \"providerAmount\",b.rejection_reason AS \"rejectionReason\",s.name AS \"serviceName\",",
  'booking rejection reason response'
);

fs.writeFileSync(serverPath, source, 'utf8');
console.log('Rejection controls applied');
