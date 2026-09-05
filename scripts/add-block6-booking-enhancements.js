const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');
let source = fs.readFileSync(serverPath, 'utf8');

function replaceOnce(needle, replacement, label) {
  if (source.includes(replacement)) return;
  if (!source.includes(needle)) throw new Error(`Block 6 booking patch failed: ${label}`);
  source = source.replace(needle, replacement);
}

replaceOnce(
  `    CREATE TABLE IF NOT EXISTS email_verification_codes (`,
  `    CREATE TABLE IF NOT EXISTS booking_reschedule_requests (\n      id BIGSERIAL PRIMARY KEY,\n      booking_id BIGINT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,\n      requested_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,\n      proposed_at TIMESTAMPTZ NOT NULL,\n      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','cancelled')),\n      note TEXT NOT NULL DEFAULT '',\n      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),\n      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()\n    );\n    CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_reschedule_one_pending ON booking_reschedule_requests(booking_id) WHERE status='pending';\n    CREATE INDEX IF NOT EXISTS idx_booking_reschedule_booking_created ON booking_reschedule_requests(booking_id, created_at DESC);\n    CREATE TABLE IF NOT EXISTS email_verification_codes (`,
  'booking reschedule table'
);

replaceOnce(
  `      b.provider_amount::float AS "providerAmount",b.rejection_reason AS "rejectionReason",s.name AS "serviceName",`,
  `      b.provider_amount::float AS "providerAmount",b.rejection_reason AS "rejectionReason",b.notes,\n      COALESCE((SELECT a.duration_minutes FROM availability a WHERE a.service_id=b.service_id AND a.starts_at=b.scheduled_at LIMIT 1),60)::int AS "durationMinutes",s.name AS "serviceName",`,
  'booking detail fields'
);

const routes = `
app.get('/api/booking-reschedules', auth, allow('user'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(\`SELECT r.id,r.booking_id AS "bookingId",r.requested_by AS "requestedBy",r.proposed_at AS "proposedAt",r.status,r.note,
      r.created_at AS "createdAt",b.service_id AS "serviceId",b.scheduled_at AS "currentDate",b.status AS "bookingStatus",s.name AS "serviceName",
      CASE WHEN r.requested_by=$1 THEN TRUE ELSE FALSE END AS "requestedByMe"
      FROM booking_reschedule_requests r JOIN bookings b ON b.id=r.booking_id JOIN services s ON s.id=b.service_id
      WHERE b.client_id=$1 OR s.provider_id=$1 ORDER BY r.created_at DESC LIMIT 200\`, [req.user.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

app.post('/api/bookings/:id/reschedule', auth, allow('user'), async (req, res, next) => {
  try {
    const proposedAt = new Date(req.body.date);
    const note = String(req.body.note || '').trim().slice(0, 500);
    if (Number.isNaN(proposedAt.valueOf()) || proposedAt <= new Date()) return res.status(400).json({ error: 'Selecciona un horario futuro válido' });
    const { rows: bookingRows } = await pool.query(\`SELECT b.id,b.service_id,b.client_id,b.scheduled_at,b.status,s.provider_id,s.name AS service_name
      FROM bookings b JOIN services s ON s.id=b.service_id WHERE b.id=$1\`, [req.params.id]);
    const booking = bookingRows[0];
    if (!booking) return res.status(404).json({ error: 'Reserva no encontrada' });
    const isClient = String(booking.client_id) === String(req.user.id);
    const isProvider = String(booking.provider_id) === String(req.user.id);
    if (!isClient && !isProvider) return res.status(403).json({ error: 'No tienes acceso a esta reserva' });
    if (!['pending','confirmed'].includes(booking.status)) return res.status(409).json({ error: 'Esta reserva ya no puede cambiar de horario' });
    const { rows: slots } = await pool.query(\`SELECT id FROM availability WHERE service_id=$1 AND starts_at=$2 AND available=TRUE AND starts_at>NOW() LIMIT 1\`, [booking.service_id, proposedAt]);
    if (!slots[0]) return res.status(409).json({ error: 'Ese horario ya no está disponible' });
    const { rows } = await pool.query(\`INSERT INTO booking_reschedule_requests(booking_id,requested_by,proposed_at,note)
      VALUES($1,$2,$3,$4)
      RETURNING id,booking_id AS "bookingId",requested_by AS "requestedBy",proposed_at AS "proposedAt",status,note,created_at AS "createdAt"\`,
      [booking.id, req.user.id, proposedAt, note]);
    const recipientId = isClient ? booking.provider_id : booking.client_id;
    const message = note ? \`Propuse cambiar la reserva de \${booking.service_name} a \${proposedAt.toLocaleString('es-US')}. Nota: \${note}\` : \`Propuse cambiar la reserva de \${booking.service_name} a \${proposedAt.toLocaleString('es-US')}.\`;
    await pool.query(\`INSERT INTO messages(service_id,sender_id,recipient_id,body) VALUES($1,$2,$3,$4)\`, [booking.service_id, req.user.id, recipientId, message]);
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Ya existe una propuesta de cambio pendiente para esta reserva' });
    next(e);
  }
});

app.patch('/api/booking-reschedules/:id/status', auth, allow('user'), async (req, res, next) => {
  try {
    const nextStatus = String(req.body.status || '');
    if (!['accepted','declined','cancelled'].includes(nextStatus)) return res.status(400).json({ error: 'Estado de cambio inválido' });
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(\`SELECT r.id,r.booking_id,r.requested_by,r.proposed_at,r.status,b.service_id,b.client_id,b.scheduled_at,b.status AS booking_status,s.provider_id,s.name AS service_name
        FROM booking_reschedule_requests r JOIN bookings b ON b.id=r.booking_id JOIN services s ON s.id=b.service_id
        WHERE r.id=$1 FOR UPDATE\`, [req.params.id]);
      const item = rows[0];
      if (!item) return { missing: true };
      const isClient = String(item.client_id) === String(req.user.id);
      const isProvider = String(item.provider_id) === String(req.user.id);
      if (!isClient && !isProvider) return { forbidden: true };
      if (item.status !== 'pending' || !['pending','confirmed'].includes(item.booking_status)) return { stale: true };
      const requestedByMe = String(item.requested_by) === String(req.user.id);
      if (nextStatus === 'accepted' && requestedByMe) return { selfAccept: true };
      if (nextStatus === 'cancelled' && !requestedByMe) return { forbidden: true };
      if (nextStatus === 'declined' && requestedByMe) return { forbidden: true };
      if (nextStatus === 'accepted') {
        const { rows: claimed } = await client.query(\`UPDATE availability SET available=FALSE
          WHERE service_id=$1 AND starts_at=$2 AND available=TRUE AND starts_at>NOW() RETURNING id\`, [item.service_id, item.proposed_at]);
        if (!claimed[0]) return { unavailable: true };
        await client.query('UPDATE availability SET available=TRUE WHERE service_id=$1 AND starts_at=$2', [item.service_id, item.scheduled_at]);
        await client.query('UPDATE bookings SET scheduled_at=$1 WHERE id=$2', [item.proposed_at, item.booking_id]);
      }
      const { rows: updated } = await client.query(\`UPDATE booking_reschedule_requests SET status=$1,updated_at=NOW() WHERE id=$2
        RETURNING id,booking_id AS "bookingId",proposed_at AS "proposedAt",status\`, [nextStatus, item.id]);
      const recipientId = isClient ? item.provider_id : item.client_id;
      const action = nextStatus === 'accepted' ? 'aceptó' : nextStatus === 'declined' ? 'rechazó' : 'canceló';
      await client.query(\`INSERT INTO messages(service_id,sender_id,recipient_id,body) VALUES($1,$2,$3,$4)\`, [item.service_id, req.user.id, recipientId, \`Se \${action} la propuesta de cambio de horario para \${item.service_name}.\`]);
      return { item: updated[0] };
    });
    if (result.missing) return res.status(404).json({ error: 'Propuesta de cambio no encontrada' });
    if (result.forbidden) return res.status(403).json({ error: 'No puedes realizar esta acción' });
    if (result.selfAccept) return res.status(409).json({ error: 'La otra persona debe aceptar el cambio de horario' });
    if (result.stale) return res.status(409).json({ error: 'Esta propuesta ya no está disponible' });
    if (result.unavailable) return res.status(409).json({ error: 'El horario propuesto ya no está disponible. Propón otro horario.' });
    res.json(result.item);
  } catch (e) { next(e); }
});

`;

replaceOnce(
  `app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));`,
  routes + `app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));`,
  'booking reschedule routes'
);

fs.writeFileSync(serverPath, source, 'utf8');
console.log('Block 6 booking enhancements applied');
