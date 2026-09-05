const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');
let source = fs.readFileSync(serverPath, 'utf8');

function replaceOnce(needle, replacement, label) {
  if (source.includes(replacement)) return;
  if (!source.includes(needle)) throw new Error(`Block 6 verified reviews patch failed: ${label}`);
  source = source.replace(needle, replacement);
}

replaceOnce(
  `    const { rows: reviews } = await pool.query(\`SELECT r.id,r.rating,r.comment,r.created_at AS "createdAt",u.name AS "reviewerName",s.name AS "serviceName"\n      FROM reviews r JOIN users u ON u.id=r.reviewer_id JOIN bookings b ON b.id=r.booking_id JOIN services s ON s.id=b.service_id\n      WHERE r.provider_id=$1 ORDER BY r.created_at DESC LIMIT 50\`, [req.params.id]);`,
  `    const { rows: reviews } = await pool.query(\`SELECT r.id,r.rating,r.comment,r.created_at AS "createdAt",u.name AS "reviewerName",s.name AS "serviceName",\n      b.scheduled_at AS "bookingDate",TRUE AS verified\n      FROM reviews r JOIN users u ON u.id=r.reviewer_id JOIN bookings b ON b.id=r.booking_id JOIN services s ON s.id=b.service_id\n      WHERE r.provider_id=$1 AND b.status='completed' ORDER BY r.created_at DESC LIMIT 50\`, [req.params.id]);`,
  'public verified review metadata'
);

const routes = `
app.get('/api/reviews/me', auth, allow('user'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(\`SELECT b.id AS "bookingId",b.service_id AS "serviceId",b.scheduled_at AS "bookingDate",b.status,
      s.name AS "serviceName",s.provider_id AS "providerId",provider.name AS "providerName",
      r.id AS "reviewId",r.rating,r.comment,r.created_at AS "reviewCreatedAt",
      CASE WHEN r.id IS NULL THEN TRUE ELSE FALSE END AS "canReview"
      FROM bookings b JOIN services s ON s.id=b.service_id JOIN users provider ON provider.id=s.provider_id
      LEFT JOIN reviews r ON r.booking_id=b.id
      WHERE b.client_id=$1 AND b.status='completed'
      ORDER BY b.scheduled_at DESC LIMIT 100\`, [req.user.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

`;
replaceOnce(
  `app.post('/api/reviews', auth, allow('user'), async (req, res, next) => {`,
  routes + `app.post('/api/reviews', auth, allow('user'), async (req, res, next) => {`,
  'verified review eligibility route'
);

replaceOnce(
  `    const { rows } = await pool.query(\`INSERT INTO reviews(booking_id,reviewer_id,provider_id,rating,comment)\n      VALUES($1,$2,$3,$4,$5) RETURNING id,rating,comment,created_at AS "createdAt"\`,\n      [booking.id, req.user.id, booking.provider_id, rating, comment]);\n    res.status(201).json(rows[0]);`,
  `    const { rows } = await pool.query(\`INSERT INTO reviews(booking_id,reviewer_id,provider_id,rating,comment)\n      VALUES($1,$2,$3,$4,$5) RETURNING id,rating,comment,created_at AS "createdAt"\`,\n      [booking.id, req.user.id, booking.provider_id, rating, comment]);\n    res.status(201).json({ ...rows[0], bookingId: booking.id, verified: true });`,
  'verified review response'
);

fs.writeFileSync(serverPath, source, 'utf8');
console.log('Block 6 verified reviews applied');
