const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');

function replaceOrThrow(source, needle, replacement, label) {
  if (!source.includes(needle)) throw new Error(`Booking flow patch failed: ${label}`);
  return source.replace(needle, replacement);
}

let source = fs.readFileSync(serverPath, 'utf8');

source = replaceOrThrow(
  source,
  "    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS provider_amount NUMERIC(10,2) NOT NULL DEFAULT 0;",
  "    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS provider_amount NUMERIC(10,2) NOT NULL DEFAULT 0;\n    ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;\n    ALTER TABLE bookings ADD CONSTRAINT bookings_status_check CHECK (status IN ('pending','confirmed','rejected','cancelled','completed'));",
  'booking status constraint'
);

source = replaceOrThrow(
  source,
  `      s.price::float,s.hourly_price::float AS hourly,s.area,u.name AS \"providerName\",u.id AS \"providerId\",\n      COALESCE((SELECT ROUND(AVG(r.rating)::numeric,1)::float FROM reviews r JOIN bookings b ON b.id=r.booking_id WHERE b.service_id=s.id),0) AS rating,\n      (SELECT COUNT(*)::int FROM reviews r JOIN bookings b ON b.id=r.booking_id WHERE b.service_id=s.id) AS \"reviewCount\"\n      FROM services s JOIN users u ON u.id=s.provider_id\n      WHERE s.active=TRUE AND u.account_status='active'\n        AND EXISTS (SELECT 1 FROM availability a WHERE a.service_id=s.id AND a.available=TRUE AND a.starts_at>NOW())\n      ORDER BY s.created_at DESC`,
  `      s.price::float,s.hourly_price::float AS hourly,s.area,u.name AS \"providerName\",u.id AS \"providerId\",\n      COALESCE((SELECT ROUND(AVG(r.rating)::numeric,1)::float FROM reviews r JOIN bookings b ON b.id=r.booking_id WHERE b.service_id=s.id),0) AS rating,\n      (SELECT COUNT(*)::int FROM reviews r JOIN bookings b ON b.id=r.booking_id WHERE b.service_id=s.id) AS \"reviewCount\",\n      EXISTS (SELECT 1 FROM availability a WHERE a.service_id=s.id AND a.available=TRUE AND a.starts_at>NOW()) AS \"hasAvailability\"\n      FROM services s JOIN users u ON u.id=s.provider_id\n      WHERE s.active=TRUE AND u.account_status='active'\n      ORDER BY s.created_at DESC`,
  'keep services visible without open slots'
);

source = replaceOrThrow(
  source,
  `    const { rows: services } = await client.query(\`SELECT s.id,s.price,s.provider_id FROM services s\n      JOIN users u ON u.id=s.provider_id WHERE s.id=$1 AND s.active=TRUE AND u.account_status='active'\`, [req.body.serviceId]);`,
  `    const { rows: services } = await client.query(\`SELECT s.id,s.name,s.price,s.provider_id FROM services s\n      JOIN users u ON u.id=s.provider_id WHERE s.id=$1 AND s.active=TRUE AND u.account_status='active'\`, [req.body.serviceId]);`,
  'booking service metadata'
);

source = replaceOrThrow(
  source,
  `    const { rows } = await client.query(\`INSERT INTO bookings(\n      service_id,client_id,scheduled_at,total,payment_status,platform_fee,provider_amount,notes\n    ) VALUES($1,$2,$3,$4,'not_started',$5,$6,$7)\n      RETURNING id,service_id AS \"serviceId\",scheduled_at AS date,total::float,status,\n      payment_status AS \"paymentStatus\",platform_fee::float AS \"platformFee\",\n      provider_amount::float AS \"providerAmount\",created_at\`,\n      [services[0].id, req.user.id, scheduledAt, total, platformFee, providerAmount, notes]);\n    await client.query('COMMIT');\n    res.status(201).json({ booking: rows[0] });`,
  `    const { rows } = await client.query(\`INSERT INTO bookings(\n      service_id,client_id,scheduled_at,total,payment_status,platform_fee,provider_amount,notes\n    ) VALUES($1,$2,$3,$4,'not_started',$5,$6,$7)\n      RETURNING id,service_id AS \"serviceId\",scheduled_at AS date,total::float,status,\n      payment_status AS \"paymentStatus\",platform_fee::float AS \"platformFee\",\n      provider_amount::float AS \"providerAmount\",created_at\`,\n      [services[0].id, req.user.id, scheduledAt, total, platformFee, providerAmount, notes]);\n    const requestMessage = notes || \`Hola, envié una solicitud para \${services[0].name} el \${scheduledAt.toLocaleString('es-US')}. ¿Podemos hablar de los detalles?\`;\n    await client.query(\`INSERT INTO messages(service_id,sender_id,recipient_id,body) VALUES($1,$2,$3,$4)\`,\n      [services[0].id, req.user.id, services[0].provider_id, requestMessage]);\n    await client.query('COMMIT');\n    res.status(201).json({ booking: rows[0], conversation: { serviceId: services[0].id, otherUserId: services[0].provider_id } });`,
  'automatic booking conversation'
);

source = replaceOrThrow(
  source,
  `    if (!['confirmed','cancelled','completed'].includes(status)) return res.status(400).json({ error: 'Estado inválido' });\n    const { rows } = await pool.query(\`SELECT b.id,b.client_id,s.provider_id,b.status FROM bookings b\n      JOIN services s ON s.id=b.service_id WHERE b.id=$1\`, [req.params.id]);`,
  `    if (!['confirmed','rejected','cancelled','completed'].includes(status)) return res.status(400).json({ error: 'Estado inválido' });\n    const { rows } = await pool.query(\`SELECT b.id,b.client_id,b.service_id,b.scheduled_at,s.provider_id,b.status FROM bookings b\n      JOIN services s ON s.id=b.service_id WHERE b.id=$1\`, [req.params.id]);`,
  'booking status values'
);

source = replaceOrThrow(
  source,
  `    const allowedTransitions = {\n      pending: isProvider ? ['confirmed','cancelled'] : ['cancelled'],\n      confirmed: isProvider ? ['completed','cancelled'] : ['cancelled'],\n      completed: [],\n      cancelled: []\n    };\n    if (!allowedTransitions[booking.status]?.includes(status)) return res.status(409).json({ error: 'Transición de estado no permitida' });\n    const { rows: updated } = await pool.query('UPDATE bookings SET status=$1 WHERE id=$2 RETURNING id,status', [status, booking.id]);\n    res.json(updated[0]);`,
  `    const allowedTransitions = {\n      pending: isProvider ? ['confirmed','rejected'] : ['cancelled'],\n      confirmed: isProvider ? ['completed','cancelled'] : ['cancelled'],\n      rejected: [],\n      completed: [],\n      cancelled: []\n    };\n    if (!allowedTransitions[booking.status]?.includes(status)) return res.status(409).json({ error: 'Transición de estado no permitida' });\n    const updatedBooking = await withTransaction(async (client) => {\n      const { rows: updated } = await client.query('UPDATE bookings SET status=$1 WHERE id=$2 RETURNING id,status', [status, booking.id]);\n      if (status === 'cancelled' || status === 'rejected') {\n        await client.query('UPDATE availability SET available=TRUE WHERE service_id=$1 AND starts_at=$2', [booking.service_id, booking.scheduled_at]);\n      }\n      return updated[0];\n    });\n    res.json(updatedBooking);`,
  'accept reject and release slot'
);

source = replaceOrThrow(
  source,
  `    const { rows } = await pool.query(\`SELECT b.id,b.scheduled_at AS date,b.total::float,b.status,\n      b.payment_status AS \"paymentStatus\",b.platform_fee::float AS \"platformFee\",\n      b.provider_amount::float AS \"providerAmount\",s.name AS \"serviceName\",\n      CASE WHEN b.client_id=$1 THEN 'client' ELSE 'provider' END AS perspective\n      FROM bookings b JOIN services s ON s.id=b.service_id\n      WHERE b.client_id=$1 OR s.provider_id=$1 ORDER BY b.created_at DESC\`, [req.user.id]);`,
  `    const { rows } = await pool.query(\`SELECT b.id,b.service_id AS \"serviceId\",b.scheduled_at AS date,b.total::float,b.status,\n      b.payment_status AS \"paymentStatus\",b.platform_fee::float AS \"platformFee\",\n      b.provider_amount::float AS \"providerAmount\",s.name AS \"serviceName\",\n      CASE WHEN b.client_id=$1 THEN 'client' ELSE 'provider' END AS perspective,\n      CASE WHEN b.client_id=$1 THEN s.provider_id ELSE b.client_id END AS \"otherUserId\",\n      CASE WHEN b.client_id=$1 THEN provider.name ELSE client.name END AS \"otherUserName\"\n      FROM bookings b JOIN services s ON s.id=b.service_id\n      JOIN users provider ON provider.id=s.provider_id JOIN users client ON client.id=b.client_id\n      WHERE b.client_id=$1 OR s.provider_id=$1 ORDER BY b.created_at DESC\`, [req.user.id]);`,
  'booking chat participant data'
);

fs.writeFileSync(serverPath, source, 'utf8');
console.log('Booking request/chat flow patch applied');
