const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');
let source = fs.readFileSync(serverPath, 'utf8');

function replaceOnce(needle, replacement, label) {
  if (source.includes(replacement)) return;
  if (!source.includes(needle)) throw new Error(`Block 6 provider dashboard patch failed: ${label}`);
  source = source.replace(needle, replacement);
}

const routes = `
app.get('/api/provider-dashboard', auth, allow('user'), async (req, res, next) => {
  try {
    const providerId = req.user.id;
    const [serviceStats, bookingStats, requestStats, reviewStats, recentBookings, recentRequests, topServices] = await Promise.all([
      pool.query(\`SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE active=TRUE AND COALESCE(paused,FALSE)=FALSE)::int AS active,
        COUNT(*) FILTER (WHERE COALESCE(paused,FALSE)=TRUE)::int AS paused,
        COUNT(*) FILTER (WHERE active=TRUE AND COALESCE(paused,FALSE)=FALSE AND EXISTS (
          SELECT 1 FROM availability a WHERE a.service_id=services.id AND a.available=TRUE AND a.starts_at>NOW()
        ))::int AS "ready"
        FROM services WHERE provider_id=$1\`, [providerId]),
      pool.query(\`SELECT
        COUNT(*) FILTER (WHERE b.status='pending')::int AS pending,
        COUNT(*) FILTER (WHERE b.status='confirmed' AND b.scheduled_at>NOW())::int AS upcoming,
        COUNT(*) FILTER (WHERE b.status='completed')::int AS completed,
        COUNT(*) FILTER (WHERE b.status='rejected')::int AS rejected
        FROM bookings b JOIN services s ON s.id=b.service_id WHERE s.provider_id=$1\`, [providerId]),
      pool.query(\`SELECT
        COUNT(*) FILTER (WHERE status='pending')::int AS pending,
        COUNT(*) FILTER (WHERE status='quoted')::int AS quoted,
        COUNT(*) FILTER (WHERE status='accepted')::int AS accepted
        FROM service_requests WHERE provider_id=$1\`, [providerId]),
      pool.query(\`SELECT COUNT(*)::int AS count,COALESCE(ROUND(AVG(rating)::numeric,1)::float,0) AS rating
        FROM reviews WHERE provider_id=$1\`, [providerId]),
      pool.query(\`SELECT b.id,b.service_id AS "serviceId",s.name AS "serviceName",b.status,b.scheduled_at AS "scheduledAt",
        b.total::float,client.name AS "clientName",b.created_at AS "createdAt"
        FROM bookings b JOIN services s ON s.id=b.service_id JOIN users client ON client.id=b.client_id
        WHERE s.provider_id=$1 ORDER BY b.created_at DESC LIMIT 6\`, [providerId]),
      pool.query(\`SELECT r.id,r.service_id AS "serviceId",s.name AS "serviceName",r.status,r.quote_amount::float AS "quoteAmount",
        client.name AS "clientName",r.updated_at AS "updatedAt"
        FROM service_requests r JOIN services s ON s.id=r.service_id JOIN users client ON client.id=r.client_id
        WHERE r.provider_id=$1 ORDER BY r.updated_at DESC LIMIT 6\`, [providerId]),
      pool.query(\`SELECT s.id,s.name,
        COUNT(DISTINCT b.id) FILTER (WHERE b.status='completed')::int AS "completedJobs",
        COUNT(DISTINCT r.id)::int AS "reviewCount",
        COALESCE(ROUND(AVG(r.rating)::numeric,1)::float,0) AS rating
        FROM services s
        LEFT JOIN bookings b ON b.service_id=s.id
        LEFT JOIN reviews r ON r.booking_id=b.id
        WHERE s.provider_id=$1
        GROUP BY s.id,s.name
        ORDER BY "completedJobs" DESC,"reviewCount" DESC,s.created_at DESC LIMIT 5\`, [providerId])
    ]);

    res.json({
      services: serviceStats.rows[0] || { total:0, active:0, paused:0, ready:0 },
      bookings: bookingStats.rows[0] || { pending:0, upcoming:0, completed:0, rejected:0 },
      requests: requestStats.rows[0] || { pending:0, quoted:0, accepted:0 },
      reviews: reviewStats.rows[0] || { count:0, rating:0 },
      recentBookings: recentBookings.rows,
      recentRequests: recentRequests.rows,
      topServices: topServices.rows
    });
  } catch (e) { next(e); }
});

`;

replaceOnce(
  `app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));`,
  routes + `app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));`,
  'provider dashboard route'
);

fs.writeFileSync(serverPath, source, 'utf8');
console.log('Block 6 provider dashboard applied');
