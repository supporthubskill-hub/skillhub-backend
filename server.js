require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');

const required = ['DATABASE_URL', 'JWT_SECRET'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
if (process.env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET must contain at least 32 characters');

const app = express();
const port = Number(process.env.PORT) || 4000;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    const allowed = (process.env.FRONTEND_URL || '').split(',').map((v) => v.trim()).filter(Boolean);
    if (!origin || allowed.includes(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed'));
  }
}));
app.use(express.json({ limit: '32kb' }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }));

const cleanEmail = (value) => String(value || '').trim().toLowerCase();
const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const publicUser = (u) => ({ id: u.id, email: u.email, role: u.role, name: u.name });

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'admin')),
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS headline TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS skills TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS languages TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS location TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS remote_available BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS experience TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS portfolio_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
    UPDATE users SET role='user' WHERE role IN ('client','provider');
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user','admin'));
    CREATE TABLE IF NOT EXISTS services (
      id BIGSERIAL PRIMARY KEY,
      provider_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      service_type TEXT NOT NULL CHECK (service_type IN ('Remoto', 'Presencial')),
      price NUMERIC(10,2) NOT NULL CHECK (price >= 0),
      hourly_price NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (hourly_price >= 0),
      area TEXT NOT NULL DEFAULT 'Remoto',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bookings (
      id BIGSERIAL PRIMARY KEY,
      service_id BIGINT NOT NULL REFERENCES services(id),
      client_id BIGINT NOT NULL REFERENCES users(id),
      scheduled_at TIMESTAMPTZ NOT NULL,
      total NUMERIC(10,2) NOT NULL CHECK (total >= 0),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','cancelled','completed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';
    CREATE TABLE IF NOT EXISTS reviews (
      id BIGSERIAL PRIMARY KEY,
      booking_id BIGINT UNIQUE NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      reviewer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment TEXT NOT NULL CHECK (char_length(comment) BETWEEN 3 AND 1000),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS availability (
      id BIGSERIAL PRIMARY KEY,
      service_id BIGINT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      provider_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      starts_at TIMESTAMPTZ NOT NULL,
      duration_minutes INTEGER NOT NULL DEFAULT 60 CHECK (duration_minutes BETWEEN 15 AND 480),
      available BOOLEAN NOT NULL DEFAULT TRUE,
      UNIQUE(service_id, starts_at)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      service_id BIGINT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function auth(req, res, next) {
  const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); return next(); }
  catch { return res.status(401).json({ error: 'Invalid or expired token' }); }
}

const allow = (...roles) => (req, res, next) => roles.includes(req.user.role)
  ? next() : res.status(403).json({ error: 'Insufficient permissions' });

app.get('/api/health', async (_req, res, next) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'ok' }); } catch (e) { next(e); }
});

app.post('/api/auth/register', async (req, res, next) => {
  try {
    const email = cleanEmail(req.body.email);
    const password = String(req.body.password || '');
    const name = String(req.body.name || '').trim();
    const role = 'user';
    if (!validEmail(email) || password.length < 8 || password.length > 128 || name.length < 2 || name.length > 80) {
      return res.status(400).json({ error: 'Check name, email, and password (minimum 8 characters)' });
    }
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      'INSERT INTO users(email,password_hash,role,name) VALUES($1,$2,$3,$4) RETURNING id,email,role,name',
      [email, hash, role, name]
    );
    const user = rows[0];
    const token = jwt.sign(publicUser(user), process.env.JWT_SECRET, { expiresIn: '2h', issuer: 'skillhub' });
    res.status(201).json({ token, user: publicUser(user) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email already registered' });
    next(e);
  }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [cleanEmail(req.body.email)]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(String(req.body.password || ''), user.password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign(publicUser(user), process.env.JWT_SECRET, { expiresIn: '2h', issuer: 'skillhub' });
    res.json({ token, user: publicUser(user) });
  } catch (e) { next(e); }
});

app.get('/api/services', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT s.id,s.name,s.description AS desc,s.category AS cat,s.service_type AS type,
      s.price::float,s.hourly_price::float AS hourly,s.area,u.name AS "providerName",u.id AS "providerId",
      COALESCE((SELECT ROUND(AVG(r.rating)::numeric,1)::float FROM reviews r JOIN bookings b ON b.id=r.booking_id WHERE b.service_id=s.id),0) AS rating,
      (SELECT COUNT(*)::int FROM reviews r JOIN bookings b ON b.id=r.booking_id WHERE b.service_id=s.id) AS "reviewCount"
      FROM services s JOIN users u ON u.id=s.provider_id WHERE s.active=TRUE ORDER BY s.created_at DESC`);
    res.json(rows);
  } catch (e) { next(e); }
});

app.post('/api/services', auth, allow('user'), async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const desc = String(req.body.desc || req.body.description || '').trim();
    const cat = String(req.body.cat || req.body.category || '').trim();
    const type = req.body.type === 'Presencial' ? 'Presencial' : 'Remoto';
    const price = Number(req.body.price);
    const hourly = Number(req.body.hourly || 0);
    const area = String(req.body.area || 'Remoto').trim();
    if (name.length < 3 || name.length > 120 || desc.length < 10 || desc.length > 1000 || !cat || !Number.isFinite(price) || price < 0 || !Number.isFinite(hourly) || hourly < 0) {
      return res.status(400).json({ error: 'Invalid service data' });
    }
    const { rows } = await pool.query(`INSERT INTO services(provider_id,name,description,category,service_type,price,hourly_price,area)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,name,description AS desc,category AS cat,service_type AS type,price::float,hourly_price::float AS hourly,area`,
      [req.user.id, name, desc, cat, type, price, hourly, area]);
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});

app.get('/api/services/:id/availability', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT id,starts_at AS "startsAt",duration_minutes AS "durationMinutes"
      FROM availability WHERE service_id=$1 AND available=TRUE AND starts_at>NOW() ORDER BY starts_at LIMIT 100`, [req.params.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

app.get('/api/availability/me', auth, allow('user'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT a.id,a.service_id AS "serviceId",s.name AS "serviceName",
      a.starts_at AS "startsAt",a.duration_minutes AS "durationMinutes",a.available
      FROM availability a JOIN services s ON s.id=a.service_id WHERE a.provider_id=$1 AND a.starts_at>NOW()
      ORDER BY a.starts_at`, [req.user.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

app.post('/api/availability', auth, allow('user'), async (req, res, next) => {
  try {
    const serviceId = Number(req.body.serviceId);
    const startsAt = new Date(req.body.startsAt);
    const duration = Number(req.body.durationMinutes || 60);
    if (!Number.isInteger(serviceId) || Number.isNaN(startsAt.valueOf()) || startsAt <= new Date() ||
        !Number.isInteger(duration) || duration < 15 || duration > 480) {
      return res.status(400).json({ error: 'Horario inválido' });
    }
    const { rows: owned } = await pool.query('SELECT 1 FROM services WHERE id=$1 AND provider_id=$2', [serviceId, req.user.id]);
    if (!owned[0]) return res.status(403).json({ error: 'Solo el propietario puede añadir horarios' });
    const { rows } = await pool.query(`INSERT INTO availability(service_id,provider_id,starts_at,duration_minutes)
      VALUES($1,$2,$3,$4) RETURNING id,service_id AS "serviceId",starts_at AS "startsAt",duration_minutes AS "durationMinutes",available`,
      [serviceId, req.user.id, startsAt, duration]);
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Ese horario ya existe' });
    next(e);
  }
});

app.delete('/api/availability/:id', auth, allow('user'), async (req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM availability WHERE id=$1 AND provider_id=$2 AND available=TRUE', [req.params.id, req.user.id]);
    if (!rowCount) return res.status(404).json({ error: 'Horario no encontrado' });
    res.status(204).end();
  } catch (e) { next(e); }
});

app.post('/api/bookings', auth, allow('user'), async (req, res, next) => {
  try {
    const scheduledAt = new Date(req.body.date);
    if (!Number.isInteger(Number(req.body.serviceId)) || Number.isNaN(scheduledAt.valueOf()) || scheduledAt <= new Date()) {
      return res.status(400).json({ error: 'Invalid service or future date' });
    }
    const { rows: services } = await pool.query('SELECT id,price,provider_id FROM services WHERE id=$1 AND active=TRUE', [req.body.serviceId]);
    if (!services[0]) return res.status(404).json({ error: 'Servicio no encontrado' });
    if (String(services[0].provider_id) === String(req.user.id)) return res.status(400).json({ error: 'No puedes reservar tu propio servicio' });
    const { rows: slots } = await pool.query(`UPDATE availability SET available=FALSE
      WHERE service_id=$1 AND starts_at=$2 AND available=TRUE RETURNING id`, [services[0].id, scheduledAt]);
    if (!slots[0]) return res.status(409).json({ error: 'Ese horario ya no está disponible' });
    const { rows } = await pool.query(`INSERT INTO bookings(service_id,client_id,scheduled_at,total)
      VALUES($1,$2,$3,$4) RETURNING id,service_id AS "serviceId",scheduled_at AS date,total::float,status,created_at`,
      [services[0].id, req.user.id, scheduledAt, services[0].price]);
    const notes = String(req.body.notes || '').trim().slice(0, 1000);
    if (notes) await pool.query('UPDATE bookings SET notes=$1 WHERE id=$2', [notes, rows[0].id]);
    res.status(201).json({ booking: rows[0] });
  } catch (e) { next(e); }
});

app.post('/api/messages', auth, allow('user'), async (req, res, next) => {
  try {
    const body = String(req.body.message || '').trim();
    const serviceId = Number(req.body.serviceId);
    if (!Number.isInteger(serviceId) || body.length < 1 || body.length > 1000) {
      return res.status(400).json({ error: 'Escribe un mensaje de 1 a 1000 caracteres' });
    }
    const { rows: services } = await pool.query('SELECT provider_id FROM services WHERE id=$1 AND active=TRUE', [serviceId]);
    if (!services[0]) return res.status(404).json({ error: 'Servicio no encontrado' });
    const isProvider = String(services[0].provider_id) === String(req.user.id);
    let recipientId = services[0].provider_id;
    if (isProvider) {
      recipientId = Number(req.body.recipientId);
      const { rows: prior } = await pool.query(`SELECT 1 FROM messages WHERE service_id=$1
        AND ((sender_id=$2 AND recipient_id=$3) OR (sender_id=$3 AND recipient_id=$2)) LIMIT 1`,
        [serviceId, req.user.id, recipientId]);
      if (!Number.isInteger(recipientId) || !prior[0]) return res.status(403).json({ error: 'Conversación no autorizada' });
    }
    if (String(recipientId) === String(req.user.id)) return res.status(400).json({ error: 'No puedes contactarte a ti mismo' });
    const { rows } = await pool.query(`INSERT INTO messages(service_id,sender_id,recipient_id,body)
      VALUES($1,$2,$3,$4) RETURNING id,service_id AS "serviceId",sender_id AS "senderId",recipient_id AS "recipientId",body,created_at`,
      [serviceId, req.user.id, recipientId, body]);
    res.status(201).json({ message: rows[0] });
  } catch (e) { next(e); }
});

app.get('/api/conversations', auth, allow('user'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT DISTINCT ON (m.service_id, CASE WHEN m.sender_id=$1 THEN m.recipient_id ELSE m.sender_id END)
      m.service_id AS "serviceId",s.name AS "serviceName",
      CASE WHEN m.sender_id=$1 THEN m.recipient_id ELSE m.sender_id END AS "otherUserId",
      CASE WHEN m.sender_id=$1 THEN recipient.name ELSE sender.name END AS "otherUserName",
      m.body AS "lastMessage",m.created_at AS "updatedAt"
      FROM messages m JOIN services s ON s.id=m.service_id
      JOIN users sender ON sender.id=m.sender_id JOIN users recipient ON recipient.id=m.recipient_id
      WHERE m.sender_id=$1 OR m.recipient_id=$1
      ORDER BY m.service_id,CASE WHEN m.sender_id=$1 THEN m.recipient_id ELSE m.sender_id END,m.created_at DESC`, [req.user.id]);
    res.json(rows.sort((a,b) => new Date(b.updatedAt)-new Date(a.updatedAt)));
  } catch (e) { next(e); }
});

app.get('/api/messages/:serviceId/:otherUserId', auth, allow('user'), async (req, res, next) => {
  try {
    const serviceId = Number(req.params.serviceId);
    const otherUserId = Number(req.params.otherUserId);
    if (!Number.isInteger(serviceId) || !Number.isInteger(otherUserId)) return res.status(400).json({ error: 'Conversación inválida' });
    const { rows } = await pool.query(`SELECT m.id,m.sender_id AS "senderId",m.recipient_id AS "recipientId",m.body,m.created_at AS "createdAt"
      FROM messages m WHERE m.service_id=$1
      AND ((m.sender_id=$2 AND m.recipient_id=$3) OR (m.sender_id=$3 AND m.recipient_id=$2))
      ORDER BY m.created_at ASC`, [serviceId, req.user.id, otherUserId]);
    res.json(rows);
  } catch (e) { next(e); }
});

app.patch('/api/bookings/:id/status', auth, allow('user'), async (req, res, next) => {
  try {
    const status = String(req.body.status || '');
    if (!['confirmed','cancelled','completed'].includes(status)) return res.status(400).json({ error: 'Estado inválido' });
    const { rows } = await pool.query(`SELECT b.id,b.client_id,s.provider_id,b.status FROM bookings b
      JOIN services s ON s.id=b.service_id WHERE b.id=$1`, [req.params.id]);
    const booking = rows[0];
    if (!booking) return res.status(404).json({ error: 'Reserva no encontrada' });
    const isProvider = String(booking.provider_id) === String(req.user.id);
    const isClient = String(booking.client_id) === String(req.user.id);
    if ((!isProvider && !isClient) || (['confirmed','completed'].includes(status) && !isProvider)) {
      return res.status(403).json({ error: 'No tienes permiso para cambiar este estado' });
    }
    const { rows: updated } = await pool.query('UPDATE bookings SET status=$1 WHERE id=$2 RETURNING id,status', [status, booking.id]);
    res.json(updated[0]);
  } catch (e) { next(e); }
});

app.put('/api/profile', auth, allow('user'), async (req, res, next) => {
  try {
    const headline = String(req.body.headline || '').trim().slice(0, 100);
    const bio = String(req.body.bio || '').trim().slice(0, 600);
    const skills = String(req.body.skills || '').trim().slice(0, 300);
    const languages = String(req.body.languages || '').trim().slice(0, 200);
    const location = String(req.body.location || '').trim().slice(0, 100);
    const remoteAvailable = req.body.remoteAvailable !== false;
    const avatarUrl = String(req.body.avatarUrl || '').trim().slice(0, 500);
    const experience = String(req.body.experience || '').trim().slice(0, 600);
    const portfolioUrl = String(req.body.portfolioUrl || '').trim().slice(0, 500);
    if (portfolioUrl && !/^https?:\/\//i.test(portfolioUrl)) return res.status(400).json({ error: 'El portafolio debe comenzar con http:// o https://' });
    if (avatarUrl && !/^https:\/\//i.test(avatarUrl)) return res.status(400).json({ error: 'La imagen debe usar una dirección https://' });
    const { rows } = await pool.query(`UPDATE users SET headline=$1,bio=$2,skills=$3,languages=$4,location=$5,remote_available=$6,avatar_url=$7,experience=$8,portfolio_url=$9 WHERE id=$10
      RETURNING id,name,headline,bio,skills,languages,location,remote_available AS "remoteAvailable",avatar_url AS "avatarUrl",experience,portfolio_url AS "portfolioUrl"`,
      [headline,bio,skills,languages,location,remoteAvailable,avatarUrl,experience,portfolioUrl,req.user.id]);
    res.json(rows[0]);
  } catch (e) { next(e); }
});

app.get('/api/providers/:id', async (req, res, next) => {
  try {
    const { rows: users } = await pool.query(`SELECT id,name,headline,bio,skills,languages,location,remote_available AS "remoteAvailable",avatar_url AS "avatarUrl",experience,portfolio_url AS "portfolioUrl",
      COALESCE((SELECT ROUND(AVG(r.rating)::numeric,1)::float FROM reviews r WHERE r.provider_id=users.id),0) AS rating,
      (SELECT COUNT(*)::int FROM reviews r WHERE r.provider_id=users.id) AS "reviewCount"
      FROM users WHERE id=$1 AND role!='admin'`, [req.params.id]);
    if (!users[0]) return res.status(404).json({ error: 'Perfil no encontrado' });
    const { rows: services } = await pool.query('SELECT id,name,description AS desc,price::float,area FROM services WHERE provider_id=$1 AND active=TRUE ORDER BY created_at DESC', [req.params.id]);
    const { rows: reviews } = await pool.query(`SELECT r.id,r.rating,r.comment,r.created_at AS "createdAt",u.name AS "reviewerName",s.name AS "serviceName"
      FROM reviews r JOIN users u ON u.id=r.reviewer_id JOIN bookings b ON b.id=r.booking_id JOIN services s ON s.id=b.service_id
      WHERE r.provider_id=$1 ORDER BY r.created_at DESC LIMIT 50`, [req.params.id]);
    res.json({ profile: users[0], services, reviews });
  } catch (e) { next(e); }
});

app.post('/api/reviews', auth, allow('user'), async (req, res, next) => {
  try {
    const bookingId = Number(req.body.bookingId);
    const rating = Number(req.body.rating);
    const comment = String(req.body.comment || '').trim();
    if (!Number.isInteger(bookingId) || !Number.isInteger(rating) || rating < 1 || rating > 5 || comment.length < 3 || comment.length > 1000) {
      return res.status(400).json({ error: 'Reseña inválida' });
    }
    const { rows: bookings } = await pool.query(`SELECT b.id,b.client_id,b.status,s.provider_id FROM bookings b JOIN services s ON s.id=b.service_id WHERE b.id=$1`, [bookingId]);
    const booking = bookings[0];
    if (!booking || String(booking.client_id) !== String(req.user.id) || booking.status !== 'completed') {
      return res.status(403).json({ error: 'Solo puedes reseñar una reserva completada' });
    }
    const { rows } = await pool.query(`INSERT INTO reviews(booking_id,reviewer_id,provider_id,rating,comment)
      VALUES($1,$2,$3,$4,$5) RETURNING id,rating,comment,created_at AS "createdAt"`,
      [booking.id, req.user.id, booking.provider_id, rating, comment]);
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Esta reserva ya tiene una reseña' });
    next(e);
  }
});

app.get('/api/bookings/me', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT b.id,b.scheduled_at AS date,b.total::float,b.status,s.name AS "serviceName",
      CASE WHEN b.client_id=$1 THEN 'client' ELSE 'provider' END AS perspective
      FROM bookings b JOIN services s ON s.id=b.service_id
      WHERE b.client_id=$1 OR s.provider_id=$1 ORDER BY b.created_at DESC`, [req.user.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, _req, res, _next) => {
  console.error(err.message);
  res.status(500).json({ error: 'Internal server error' });
});

initDb().then(() => app.listen(port, () => console.log(`SkillHub API listening on ${port}`)))
  .catch((err) => { console.error(err); process.exit(1); });

module.exports = app;
