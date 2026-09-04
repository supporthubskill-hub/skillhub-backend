require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');

const required = ['DATABASE_URL', 'JWT_SECRET'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
if (process.env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET must contain at least 32 characters');

const app = express();
const port = Number(process.env.PORT) || 4000;
const COMMISSION_RATE = 0.10;
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
const verificationLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: true, legacyHeaders: false });

const cleanEmail = (value) => String(value || '').trim().toLowerCase();
const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const publicUser = (u) => ({ id: u.id, email: u.email, role: u.role, name: u.name, emailVerified: Boolean(u.email_verified) });

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
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS identity_status TEXT NOT NULL DEFAULT 'unverified';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS headline TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS skills TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS languages TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS location TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS remote_available BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS experience TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS portfolio_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status TEXT NOT NULL DEFAULT 'active';
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
    UPDATE users SET role='user' WHERE role IN ('client','provider');
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user','admin'));
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_account_status_check;
    ALTER TABLE users ADD CONSTRAINT users_account_status_check CHECK (account_status IN ('active','suspended'));
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
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'not_started';
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS platform_fee NUMERIC(10,2) NOT NULL DEFAULT 0;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS provider_amount NUMERIC(10,2) NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS reports (
      id BIGSERIAL PRIMARY KEY,
      reporter_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      service_id BIGINT REFERENCES services(id) ON DELETE SET NULL,
      reason TEXT NOT NULL,
      details TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewing','resolved','dismissed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS disputes (
      id BIGSERIAL PRIMARY KEY,
      booking_id BIGINT UNIQUE NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      opened_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      details TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewing','resolved','dismissed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
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
    CREATE TABLE IF NOT EXISTS email_verification_codes (
      user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_email_verification_expires ON email_verification_codes(expires_at);
    CREATE TABLE IF NOT EXISTS admin_actions (
      id BIGSERIAL PRIMARY KEY,
      admin_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id BIGINT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_admin_actions_created_at ON admin_actions(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_users_account_identity ON users(account_status, identity_status);
    CREATE INDEX IF NOT EXISTS idx_services_active_created ON services(active, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_reports_status_created ON reports(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_disputes_status_created ON disputes(status, created_at DESC);
  `);
}

async function auth(req, res, next) {
  const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, { issuer: 'skillhub' });
    const { rows } = await pool.query('SELECT id,email,role,name,account_status,email_verified FROM users WHERE id=$1', [payload.id]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Account not found' });
    if (user.account_status === 'suspended') return res.status(403).json({ error: 'Account suspended' });
    req.user = publicUser(user);
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

const allow = (...roles) => (req, res, next) => roles.includes(req.user.role)
  ? next() : res.status(403).json({ error: 'Insufficient permissions' });

async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

app.get('/api/health', async (_req, res, next) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'ok' }); } catch (e) { next(e); }
});

app.get('/api/payments/config', (_req, res) => {
  res.json({
    enabled: false,
    mode: 'test_only',
    currency: 'usd',
    commissionRate: COMMISSION_RATE,
    message: 'Los pagos reales todavía no están activados.'
  });
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
    if (!user || user.account_status === 'suspended' || !(await bcrypt.compare(String(req.body.password || ''), user.password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign(publicUser(user), process.env.JWT_SECRET, { expiresIn: '2h', issuer: 'skillhub' });
    res.json({ token, user: publicUser(user) });
  } catch (e) { next(e); }
});

const hashVerificationCode = (code) => crypto
  .createHmac('sha256', process.env.JWT_SECRET)
  .update(String(code))
  .digest('hex');

function createMailTransport() {
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASS || '').trim();
  if (!user || !pass) throw new Error('Email verification is not configured');
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE || 'true').toLowerCase() !== 'false',
    auth: { user, pass }
  });
}

async function sendVerificationMail(email, code) {
  const transporter = createMailTransport();
  const from = process.env.EMAIL_FROM || `SkillHub <${process.env.SMTP_USER}>`;
  await transporter.sendMail({
    from,
    to: email,
    subject: 'Tu código de verificación de SkillHub',
    text: `Tu código de verificación de SkillHub es ${code}. Expira en 10 minutos. Si no solicitaste este código, ignora este correo.`,
    html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px"><h2>Verifica tu correo en SkillHub</h2><p>Usa este código para confirmar tu correo:</p><div style="font-size:32px;font-weight:700;letter-spacing:8px;margin:24px 0">${code}</div><p>El código expira en 10 minutos.</p><p style="color:#64748b;font-size:13px">Si no solicitaste este código, puedes ignorar este mensaje.</p></div>`
  });
}

app.get('/api/verification/status', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT email_verified,phone_verified,identity_status FROM users WHERE id=$1', [req.user.id]);
    const user = rows[0];
    res.json({
      emailVerified: Boolean(user?.email_verified),
      phoneVerified: Boolean(user?.phone_verified),
      identityStatus: user?.identity_status || 'unverified'
    });
  } catch (e) { next(e); }
});

app.post('/api/verification/email/send', auth, verificationLimiter, async (req, res, next) => {
  try {
    const { rows: userRows } = await pool.query('SELECT email,email_verified FROM users WHERE id=$1', [req.user.id]);
    const user = userRows[0];
    if (!user) return res.status(404).json({ error: 'Cuenta no encontrada' });
    if (user.email_verified) return res.json({ verified: true, message: 'Tu correo ya está verificado.' });

    const { rows: existingRows } = await pool.query('SELECT last_sent_at FROM email_verification_codes WHERE user_id=$1', [req.user.id]);
    const lastSent = existingRows[0]?.last_sent_at ? new Date(existingRows[0].last_sent_at).getTime() : 0;
    const remainingMs = 60_000 - (Date.now() - lastSent);
    if (remainingMs > 0) return res.status(429).json({ error: `Espera ${Math.ceil(remainingMs / 1000)} segundos antes de pedir otro código.` });

    const code = String(crypto.randomInt(100000, 1000000));
    const codeHash = hashVerificationCode(code);
    await pool.query(`INSERT INTO email_verification_codes(user_id,code_hash,expires_at,attempts,last_sent_at)
      VALUES($1,$2,NOW() + INTERVAL '10 minutes',0,NOW())
      ON CONFLICT(user_id) DO UPDATE SET code_hash=EXCLUDED.code_hash,expires_at=EXCLUDED.expires_at,attempts=0,last_sent_at=NOW()`,
      [req.user.id, codeHash]);

    try {
      await sendVerificationMail(user.email, code);
    } catch (mailError) {
      await pool.query('DELETE FROM email_verification_codes WHERE user_id=$1 AND code_hash=$2', [req.user.id, codeHash]);
      throw mailError;
    }

    res.json({ sent: true, expiresInSeconds: 600, message: 'Código enviado. Revisa tu correo.' });
  } catch (e) { next(e); }
});

app.post('/api/verification/email/confirm', auth, verificationLimiter, async (req, res, next) => {
  try {
    const code = String(req.body.code || '').trim();
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Ingresa el código de 6 dígitos.' });

    const verified = await withTransaction(async (client) => {
      const { rows: userRows } = await client.query('SELECT email_verified FROM users WHERE id=$1 FOR UPDATE', [req.user.id]);
      if (userRows[0]?.email_verified) return true;

      const { rows } = await client.query('SELECT code_hash,expires_at,attempts FROM email_verification_codes WHERE user_id=$1 FOR UPDATE', [req.user.id]);
      const record = rows[0];
      if (!record) return null;
      if (new Date(record.expires_at).getTime() < Date.now()) {
        await client.query('DELETE FROM email_verification_codes WHERE user_id=$1', [req.user.id]);
        return 'expired';
      }
      if (record.attempts >= 5) {
        await client.query('DELETE FROM email_verification_codes WHERE user_id=$1', [req.user.id]);
        return 'locked';
      }
      if (hashVerificationCode(code) !== record.code_hash) {
        await client.query('UPDATE email_verification_codes SET attempts=attempts+1 WHERE user_id=$1', [req.user.id]);
        return false;
      }
      await client.query('UPDATE users SET email_verified=TRUE WHERE id=$1', [req.user.id]);
      await client.query('DELETE FROM email_verification_codes WHERE user_id=$1', [req.user.id]);
      return true;
    });

    if (verified === true) return res.json({ verified: true, message: 'Correo verificado correctamente.' });
    if (verified === 'expired') return res.status(400).json({ error: 'El código expiró. Solicita uno nuevo.' });
    if (verified === 'locked') return res.status(429).json({ error: 'Demasiados intentos. Solicita un código nuevo.' });
    if (verified === null) return res.status(400).json({ error: 'Primero solicita un código de verificación.' });
    return res.status(400).json({ error: 'Código incorrecto.' });
  } catch (e) { next(e); }
});

app.get('/api/services', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT s.id,s.name,s.description AS desc,s.category AS cat,s.service_type AS type,
      s.price::float,s.hourly_price::float AS hourly,s.area,u.name AS "providerName",u.id AS "providerId",
      COALESCE((SELECT ROUND(AVG(r.rating)::numeric,1)::float FROM reviews r JOIN bookings b ON b.id=r.booking_id WHERE b.service_id=s.id),0) AS rating,
      (SELECT COUNT(*)::int FROM reviews r JOIN bookings b ON b.id=r.booking_id WHERE b.service_id=s.id) AS "reviewCount"
      FROM services s JOIN users u ON u.id=s.provider_id
      WHERE s.active=TRUE AND u.account_status='active'
        AND EXISTS (SELECT 1 FROM availability a WHERE a.service_id=s.id AND a.available=TRUE AND a.starts_at>NOW())
      ORDER BY s.created_at DESC`);
    res.json(rows);
  } catch (e) { next(e); }
});

app.get('/api/services/me', auth, allow('user'), async (req, res, next) => {
  try {
    const [{ rows }, { rows: usage }] = await Promise.all([
      pool.query(`SELECT s.id,s.name,s.description AS desc,s.category AS cat,s.service_type AS type,
        s.price::float,s.hourly_price::float AS hourly,s.area,s.active,s.created_at AS "createdAt",
        EXISTS (SELECT 1 FROM availability a WHERE a.service_id=s.id AND a.available=TRUE AND a.starts_at>NOW()) AS "hasAvailability"
        FROM services s WHERE s.provider_id=$1 ORDER BY s.created_at DESC`, [req.user.id]),
      pool.query(`SELECT COUNT(*)::int AS used FROM services WHERE provider_id=$1 AND created_at >= NOW() - INTERVAL '24 hours'`, [req.user.id])
    ]);
    const used = usage[0]?.used || 0;
    res.json({ services: rows, limit: { max: 5, used, remaining: Math.max(0, 5-used) } });
  } catch (e) { next(e); }
});

function readServiceInput(req) {
  return {
    name: String(req.body.name || '').trim(),
    desc: String(req.body.desc || req.body.description || '').trim(),
    cat: String(req.body.cat || req.body.category || '').trim(),
    type: req.body.type === 'Presencial' ? 'Presencial' : 'Remoto',
    price: Number(req.body.price),
    hourly: Number(req.body.hourly || 0),
    area: String(req.body.area || 'Remoto').trim()
  };
}

function validServiceInput(v) {
  return v.name.length >= 3 && v.name.length <= 120 && v.desc.length >= 10 && v.desc.length <= 1000 &&
    v.cat.length >= 1 && v.cat.length <= 100 && Number.isFinite(v.price) && v.price >= 0 &&
    Number.isFinite(v.hourly) && v.hourly >= 0 && v.area.length <= 150;
}

app.post('/api/services', auth, allow('user'), async (req, res, next) => {
  try {
    const v = readServiceInput(req);
    if (!validServiceInput(v)) return res.status(400).json({ error: 'Revisa los datos del servicio' });
    const created = await withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [Number(req.user.id)]);
      const { rows: usage } = await client.query(`SELECT COUNT(*)::int AS used FROM services
        WHERE provider_id=$1 AND created_at >= NOW() - INTERVAL '24 hours'`, [req.user.id]);
      if ((usage[0]?.used || 0) >= 5) return null;
      const { rows } = await client.query(`INSERT INTO services(provider_id,name,description,category,service_type,price,hourly_price,area)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING id,name,description AS desc,category AS cat,service_type AS type,price::float,hourly_price::float AS hourly,area,active,created_at AS "createdAt"`,
        [req.user.id, v.name, v.desc, v.cat, v.type, v.price, v.hourly, v.area]);
      return rows[0];
    });
    if (!created) return res.status(429).json({ error: 'Puedes publicar un máximo de 5 servicios cada 24 horas' });
    res.status(201).json({ ...created, hasAvailability: false });
  } catch (e) { next(e); }
});

app.patch('/api/services/:id', auth, allow('user'), async (req, res, next) => {
  try {
    const v = readServiceInput(req);
    if (!validServiceInput(v)) return res.status(400).json({ error: 'Revisa los datos del servicio' });
    const { rows } = await pool.query(`UPDATE services SET name=$1,description=$2,category=$3,service_type=$4,price=$5,hourly_price=$6,area=$7
      WHERE id=$8 AND provider_id=$9
      RETURNING id,name,description AS desc,category AS cat,service_type AS type,price::float,hourly_price::float AS hourly,area,active,created_at AS "createdAt"`,
      [v.name,v.desc,v.cat,v.type,v.price,v.hourly,v.area,req.params.id,req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Servicio no encontrado' });
    const { rows: slots } = await pool.query(`SELECT EXISTS (SELECT 1 FROM availability WHERE service_id=$1 AND available=TRUE AND starts_at>NOW()) AS ready`, [req.params.id]);
    res.json({ ...rows[0], hasAvailability: Boolean(slots[0]?.ready) });
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

async function availabilityConflict(client, providerId, startsAt, duration, excludeId = null) {
  const { rows } = await client.query(`SELECT 1 FROM availability
    WHERE provider_id=$1 AND starts_at>NOW() AND ($4::bigint IS NULL OR id<>$4)
      AND starts_at < $2::timestamptz + ($3::int * INTERVAL '1 minute')
      AND starts_at + (duration_minutes * INTERVAL '1 minute') > $2::timestamptz
    LIMIT 1`, [providerId, startsAt, duration, excludeId]);
  return Boolean(rows[0]);
}

app.post('/api/availability', auth, allow('user'), async (req, res, next) => {
  try {
    const serviceId = Number(req.body.serviceId);
    const startsAt = new Date(req.body.startsAt);
    const duration = Number(req.body.durationMinutes || 60);
    if (!Number.isInteger(serviceId) || Number.isNaN(startsAt.valueOf()) || startsAt <= new Date() ||
        !Number.isInteger(duration) || duration < 15 || duration > 480) {
      return res.status(400).json({ error: 'Horario inválido. Elige una fecha futura y una duración entre 15 y 480 minutos' });
    }
    const created = await withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [Number(req.user.id)]);
      const { rows: owned } = await client.query('SELECT 1 FROM services WHERE id=$1 AND provider_id=$2', [serviceId, req.user.id]);
      if (!owned[0]) return { forbidden: true };
      if (await availabilityConflict(client, req.user.id, startsAt, duration)) return { conflict: true };
      const { rows } = await client.query(`INSERT INTO availability(service_id,provider_id,starts_at,duration_minutes)
        VALUES($1,$2,$3,$4) RETURNING id,service_id AS "serviceId",starts_at AS "startsAt",duration_minutes AS "durationMinutes",available`,
        [serviceId, req.user.id, startsAt, duration]);
      return { slot: rows[0] };
    });
    if (created.forbidden) return res.status(403).json({ error: 'Solo el propietario puede añadir horarios' });
    if (created.conflict) return res.status(409).json({ error: 'Ese horario se cruza con otra disponibilidad o reservación tuya' });
    res.status(201).json(created.slot);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Ese horario ya existe' });
    next(e);
  }
});

app.patch('/api/availability/:id', auth, allow('user'), async (req, res, next) => {
  try {
    const startsAt = new Date(req.body.startsAt);
    const duration = Number(req.body.durationMinutes || 60);
    if (Number.isNaN(startsAt.valueOf()) || startsAt <= new Date() || !Number.isInteger(duration) || duration < 15 || duration > 480) {
      return res.status(400).json({ error: 'Horario inválido' });
    }
    const result = await withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [Number(req.user.id)]);
      const { rows: current } = await client.query(`SELECT id,available FROM availability WHERE id=$1 AND provider_id=$2`, [req.params.id, req.user.id]);
      if (!current[0]) return { missing: true };
      if (!current[0].available) return { reserved: true };
      if (await availabilityConflict(client, req.user.id, startsAt, duration, req.params.id)) return { conflict: true };
      const { rows } = await client.query(`UPDATE availability SET starts_at=$1,duration_minutes=$2 WHERE id=$3 AND provider_id=$4 AND available=TRUE
        RETURNING id,service_id AS "serviceId",starts_at AS "startsAt",duration_minutes AS "durationMinutes",available`,
        [startsAt,duration,req.params.id,req.user.id]);
      return { slot: rows[0] };
    });
    if (result.missing) return res.status(404).json({ error: 'Horario no encontrado' });
    if (result.reserved) return res.status(409).json({ error: 'No puedes editar un horario que ya fue reservado' });
    if (result.conflict) return res.status(409).json({ error: 'Ese horario se cruza con otra disponibilidad o reservación tuya' });
    res.json(result.slot);
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
  const client = await pool.connect();
  try {
    const scheduledAt = new Date(req.body.date);
    if (!Number.isInteger(Number(req.body.serviceId)) || Number.isNaN(scheduledAt.valueOf()) || scheduledAt <= new Date()) {
      return res.status(400).json({ error: 'Invalid service or future date' });
    }
    await client.query('BEGIN');
    const { rows: services } = await client.query(`SELECT s.id,s.price,s.provider_id FROM services s
      JOIN users u ON u.id=s.provider_id WHERE s.id=$1 AND s.active=TRUE AND u.account_status='active'`, [req.body.serviceId]);
    if (!services[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Servicio no encontrado' }); }
    if (String(services[0].provider_id) === String(req.user.id)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'No puedes reservar tu propio servicio' }); }
    const { rows: slots } = await client.query(`UPDATE availability SET available=FALSE
      WHERE service_id=$1 AND starts_at=$2 AND available=TRUE RETURNING id`, [services[0].id, scheduledAt]);
    if (!slots[0]) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Ese horario ya no está disponible' }); }
    const total = Number(services[0].price);
    const platformFee = Number((total * COMMISSION_RATE).toFixed(2));
    const providerAmount = Number((total - platformFee).toFixed(2));
    const notes = String(req.body.notes || '').trim().slice(0, 1000);
    const { rows } = await client.query(`INSERT INTO bookings(
      service_id,client_id,scheduled_at,total,payment_status,platform_fee,provider_amount,notes
    ) VALUES($1,$2,$3,$4,'not_started',$5,$6,$7)
      RETURNING id,service_id AS "serviceId",scheduled_at AS date,total::float,status,
      payment_status AS "paymentStatus",platform_fee::float AS "platformFee",
      provider_amount::float AS "providerAmount",created_at`,
      [services[0].id, req.user.id, scheduledAt, total, platformFee, providerAmount, notes]);
    await client.query('COMMIT');
    res.status(201).json({ booking: rows[0] });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally {
    client.release();
  }
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
    if (!isProvider && !isClient) return res.status(403).json({ error: 'No tienes permiso para cambiar este estado' });
    const allowedTransitions = {
      pending: isProvider ? ['confirmed','cancelled'] : ['cancelled'],
      confirmed: isProvider ? ['completed','cancelled'] : ['cancelled'],
      completed: [],
      cancelled: []
    };
    if (!allowedTransitions[booking.status]?.includes(status)) return res.status(409).json({ error: 'Transición de estado no permitida' });
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
      FROM users WHERE id=$1 AND role!='admin' AND account_status='active'`, [req.params.id]);
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

app.get('/api/security/me', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT email_verified AS "emailVerified",phone_verified AS "phoneVerified",
      identity_status AS "identityStatus" FROM users WHERE id=$1`, [req.user.id]);
    res.json(rows[0]);
  } catch (e) { next(e); }
});

app.post('/api/verification/request', auth, allow('user'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(`UPDATE users SET identity_status='pending'
      WHERE id=$1 AND identity_status IN ('unverified','rejected') RETURNING identity_status AS "identityStatus"`, [req.user.id]);
    if (!rows[0]) return res.status(409).json({ error: 'La verificación ya está pendiente o completada' });
    res.json(rows[0]);
  } catch (e) { next(e); }
});

app.post('/api/reports', auth, allow('user'), async (req, res, next) => {
  try {
    const targetUserId = req.body.targetUserId ? Number(req.body.targetUserId) : null;
    const serviceId = req.body.serviceId ? Number(req.body.serviceId) : null;
    const reason = String(req.body.reason || '').trim().slice(0,100);
    const details = String(req.body.details || '').trim().slice(0,1500);
    if ((!targetUserId && !serviceId) || reason.length < 3 || details.length < 10) return res.status(400).json({ error: 'Completa el motivo y los detalles del reporte' });
    const { rows } = await pool.query(`INSERT INTO reports(reporter_id,target_user_id,service_id,reason,details)
      VALUES($1,$2,$3,$4,$5) RETURNING id,status,created_at AS "createdAt"`, [req.user.id,targetUserId,serviceId,reason,details]);
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});

app.post('/api/disputes', auth, allow('user'), async (req, res, next) => {
  try {
    const bookingId=Number(req.body.bookingId),reason=String(req.body.reason||'').trim().slice(0,100),details=String(req.body.details||'').trim().slice(0,1500);
    const { rows: b } = await pool.query(`SELECT b.id,b.client_id,s.provider_id FROM bookings b JOIN services s ON s.id=b.service_id WHERE b.id=$1`,[bookingId]);
    if(!b[0] || (String(b[0].client_id)!==String(req.user.id)&&String(b[0].provider_id)!==String(req.user.id))) return res.status(403).json({error:'No puedes abrir una disputa para esta reserva'});
    if(reason.length<3||details.length<10) return res.status(400).json({error:'Completa el motivo y los detalles'});
    const {rows}=await pool.query(`INSERT INTO disputes(booking_id,opened_by,reason,details) VALUES($1,$2,$3,$4)
      RETURNING id,status,created_at AS "createdAt"`,[bookingId,req.user.id,reason,details]);
    res.status(201).json(rows[0]);
  } catch(e){if(e.code==='23505')return res.status(409).json({error:'Esta reserva ya tiene una disputa'});next(e);}
});

app.get('/api/cases/me', auth, allow('user'), async (req,res,next)=>{
  try{
    const {rows:reports}=await pool.query('SELECT id,reason,status,created_at AS "createdAt" FROM reports WHERE reporter_id=$1 ORDER BY created_at DESC',[req.user.id]);
    const {rows:disputes}=await pool.query('SELECT id,booking_id AS "bookingId",reason,status,created_at AS "createdAt" FROM disputes WHERE opened_by=$1 ORDER BY created_at DESC',[req.user.id]);
    res.json({reports,disputes});
  }catch(e){next(e);}
});

app.get('/api/bookings/me', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT b.id,b.scheduled_at AS date,b.total::float,b.status,
      b.payment_status AS "paymentStatus",b.platform_fee::float AS "platformFee",
      b.provider_amount::float AS "providerAmount",s.name AS "serviceName",
      CASE WHEN b.client_id=$1 THEN 'client' ELSE 'provider' END AS perspective
      FROM bookings b JOIN services s ON s.id=b.service_id
      WHERE b.client_id=$1 OR s.provider_id=$1 ORDER BY b.created_at DESC`, [req.user.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

app.get('/api/admin/stats', auth, allow('admin'), async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM users WHERE role='user') AS "users",
      (SELECT COUNT(DISTINCT provider_id)::int FROM services WHERE active=TRUE) AS "sellers",
      (SELECT COUNT(*)::int FROM services WHERE active=TRUE) AS "services",
      (SELECT COUNT(*)::int FROM bookings) AS "bookings",
      (SELECT COUNT(*)::int FROM reports WHERE status IN ('open','reviewing')) AS "openReports",
      (SELECT COUNT(*)::int FROM disputes WHERE status IN ('open','reviewing')) AS "openDisputes",
      COALESCE((SELECT SUM(platform_fee)::float FROM bookings WHERE status='completed'),0) AS "testCommissions"`);
    res.json(rows[0]);
  } catch (e) { next(e); }
});

app.get('/api/admin/verifications', auth, allow('admin'), async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT id,name,email,identity_status AS "identityStatus",created_at AS "createdAt"
      FROM users WHERE role='user' AND identity_status='pending' ORDER BY created_at ASC LIMIT 200`);
    res.json(rows);
  } catch (e) { next(e); }
});

app.patch('/api/admin/verifications/:id', auth, allow('admin'), async (req, res, next) => {
  try {
    const status = String(req.body.status || '');
    if (!['verified','rejected'].includes(status)) return res.status(400).json({ error: 'Estado de verificación inválido' });
    const { rows } = await pool.query(`UPDATE users SET identity_status=$1 WHERE id=$2 AND role='user'
      RETURNING id,name,email,identity_status AS "identityStatus"`, [status, req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
    await pool.query(`INSERT INTO admin_actions(admin_id,action,target_type,target_id,reason) VALUES($1,$2,'user',$3,$4)`,
      [req.user.id, status === 'verified' ? 'verification_approved' : 'verification_rejected', req.params.id, status === 'verified' ? 'Verificación aprobada' : 'Verificación rechazada']);
    res.json(rows[0]);
  } catch (e) { next(e); }
});

app.get('/api/admin/cases', auth, allow('admin'), async (_req, res, next) => {
  try {
    const { rows: reports } = await pool.query(`SELECT r.id,'report' AS type,r.reason,r.details,r.status,r.created_at AS "createdAt",
      r.reporter_id AS "openedById",r.target_user_id AS "targetUserId",r.service_id AS "serviceId",
      reporter.name AS "openedByName",target.name AS "targetName",s.name AS "serviceName"
      FROM reports r JOIN users reporter ON reporter.id=r.reporter_id
      LEFT JOIN users target ON target.id=r.target_user_id LEFT JOIN services s ON s.id=r.service_id
      ORDER BY r.created_at DESC LIMIT 200`);
    const { rows: disputes } = await pool.query(`SELECT d.id,'dispute' AS type,d.booking_id AS "bookingId",d.reason,d.details,d.status,d.created_at AS "createdAt",
      d.opened_by AS "openedById",u.name AS "openedByName",b.client_id AS "clientId",client.name AS "clientName",
      s.provider_id AS "providerId",provider.name AS "providerName",s.id AS "serviceId",s.name AS "serviceName"
      FROM disputes d JOIN users u ON u.id=d.opened_by JOIN bookings b ON b.id=d.booking_id
      JOIN services s ON s.id=b.service_id JOIN users client ON client.id=b.client_id JOIN users provider ON provider.id=s.provider_id
      ORDER BY d.created_at DESC LIMIT 200`);
    res.json({ reports, disputes });
  } catch (e) { next(e); }
});

app.patch('/api/admin/reports/:id', auth, allow('admin'), async (req, res, next) => {
  try {
    const status = String(req.body.status || '');
    if (!['open','reviewing','resolved','dismissed'].includes(status)) return res.status(400).json({ error: 'Estado inválido' });
    const { rows } = await pool.query('UPDATE reports SET status=$1 WHERE id=$2 RETURNING id,status', [status, req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Reporte no encontrado' });
    await pool.query(`INSERT INTO admin_actions(admin_id,action,target_type,target_id,reason) VALUES($1,$2,'report',$3,$4)`,
      [req.user.id, 'report_'+status, req.params.id, 'Estado del reporte cambiado a '+status]);
    res.json(rows[0]);
  } catch (e) { next(e); }
});

app.patch('/api/admin/disputes/:id', auth, allow('admin'), async (req, res, next) => {
  try {
    const status = String(req.body.status || '');
    if (!['open','reviewing','resolved','dismissed'].includes(status)) return res.status(400).json({ error: 'Estado inválido' });
    const { rows } = await pool.query('UPDATE disputes SET status=$1 WHERE id=$2 RETURNING id,status', [status, req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Disputa no encontrada' });
    await pool.query(`INSERT INTO admin_actions(admin_id,action,target_type,target_id,reason) VALUES($1,$2,'dispute',$3,$4)`,
      [req.user.id, 'dispute_'+status, req.params.id, 'Estado de la disputa cambiado a '+status]);
    res.json(rows[0]);
  } catch (e) { next(e); }
});

app.get('/api/admin/services', auth, allow('admin'), async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().slice(0,100);
    const state = String(req.query.state || 'all');
    if (!['all','active','removed'].includes(state)) return res.status(400).json({ error: 'Filtro de servicio inválido' });
    const pattern = `%${q}%`;
    const { rows } = await pool.query(`SELECT s.id,s.name,s.category,s.area,s.active,s.created_at AS "createdAt",
      u.id AS "providerId",u.name AS "providerName",u.email AS "providerEmail",
      (SELECT COUNT(*)::int FROM bookings b WHERE b.service_id=s.id) AS "bookingCount"
      FROM services s JOIN users u ON u.id=s.provider_id
      WHERE ($1='' OR s.name ILIKE $2 OR u.name ILIKE $2 OR u.email ILIKE $2)
        AND ($3='all' OR ($3='active' AND s.active=TRUE) OR ($3='removed' AND s.active=FALSE))
      ORDER BY s.created_at DESC LIMIT 300`, [q, pattern, state]);
    res.json(rows);
  } catch (e) { next(e); }
});

app.delete('/api/admin/services/:id', auth, allow('admin'), async (req, res, next) => {
  try {
    const reason = String(req.body.reason || '').trim().slice(0,200);
    if (reason.length < 3) return res.status(400).json({ error: 'Debes indicar un motivo para retirar el servicio' });
    const service = await withTransaction(async (client) => {
      const { rows } = await client.query(`UPDATE services SET active=FALSE WHERE id=$1 AND active=TRUE
        RETURNING id,name,provider_id AS "providerId",active`, [req.params.id]);
      if (!rows[0]) return null;
      await client.query('UPDATE availability SET available=FALSE WHERE service_id=$1 AND available=TRUE', [req.params.id]);
      await client.query(`INSERT INTO admin_actions(admin_id,action,target_type,target_id,reason) VALUES($1,'service_removed','service',$2,$3)`, [req.user.id, req.params.id, reason]);
      return rows[0];
    });
    if (!service) return res.status(404).json({ error: 'Servicio no encontrado o ya eliminado' });
    res.json({ ...service, removed: true, reason });
  } catch (e) { next(e); }
});

app.patch('/api/admin/services/:id/restore', auth, allow('admin'), async (req, res, next) => {
  try {
    const reason = String(req.body.reason || 'Restaurado por administrador').trim().slice(0,200);
    const service = await withTransaction(async (client) => {
      const { rows } = await client.query(`UPDATE services SET active=TRUE WHERE id=$1 AND active=FALSE
        RETURNING id,name,provider_id AS "providerId",active`, [req.params.id]);
      if (!rows[0]) return null;
      await client.query(`INSERT INTO admin_actions(admin_id,action,target_type,target_id,reason) VALUES($1,'service_restored','service',$2,$3)`, [req.user.id, req.params.id, reason]);
      return rows[0];
    });
    if (!service) return res.status(404).json({ error: 'Servicio no encontrado o ya está activo' });
    res.json({ ...service, restored: true });
  } catch (e) { next(e); }
});

app.get('/api/admin/activity', auth, allow('admin'), async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT a.id,a.action,a.target_type AS "targetType",a.target_id AS "targetId",a.reason,a.created_at AS "createdAt",
      u.name AS "adminName" FROM admin_actions a JOIN users u ON u.id=a.admin_id ORDER BY a.created_at DESC LIMIT 50`);
    res.json(rows);
  } catch (e) { next(e); }
});

app.get('/api/admin/users/:id/details', auth, allow('admin'), async (req, res, next) => {
  try {
    const { rows: users } = await pool.query(`SELECT id,name,email,role,account_status AS "accountStatus",identity_status AS "identityStatus",
      email_verified AS "emailVerified",phone_verified AS "phoneVerified",headline,bio,skills,languages,location,experience,portfolio_url AS "portfolioUrl",created_at AS "createdAt"
      FROM users WHERE id=$1`, [req.params.id]);
    if (!users[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
    const { rows: services } = await pool.query(`SELECT id,name,category,active,created_at AS "createdAt",
      (SELECT COUNT(*)::int FROM bookings b WHERE b.service_id=services.id) AS "bookingCount"
      FROM services WHERE provider_id=$1 ORDER BY created_at DESC LIMIT 100`, [req.params.id]);
    const { rows: bookings } = await pool.query(`SELECT b.id,b.status,b.scheduled_at AS "scheduledAt",s.name AS "serviceName",
      CASE WHEN b.client_id=$1 THEN 'client' ELSE 'provider' END AS perspective
      FROM bookings b JOIN services s ON s.id=b.service_id
      WHERE b.client_id=$1 OR s.provider_id=$1 ORDER BY b.created_at DESC LIMIT 30`, [req.params.id]);
    const { rows: reports } = await pool.query(`SELECT id,reason,status,created_at AS "createdAt" FROM reports WHERE target_user_id=$1 ORDER BY created_at DESC LIMIT 30`, [req.params.id]);
    res.json({ user: users[0], services, bookings, reports });
  } catch (e) { next(e); }
});

app.get('/api/admin/users', auth, allow('admin'), async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().slice(0,100);
    const account = String(req.query.account || 'all');
    const verification = String(req.query.verification || 'all');
    if (!['all','active','suspended'].includes(account) || !['all','verified','pending','unverified','rejected'].includes(verification))
      return res.status(400).json({ error: 'Filtro de usuario inválido' });
    const pattern = `%${q}%`;
    const { rows } = await pool.query(`SELECT u.id,u.name,u.email,u.role,u.account_status AS "accountStatus",
      u.identity_status AS "identityStatus",u.created_at AS "createdAt",
      (SELECT COUNT(*)::int FROM services s WHERE s.provider_id=u.id) AS "serviceCount"
      FROM users u WHERE ($1='' OR u.name ILIKE $2 OR u.email ILIKE $2)
        AND ($3='all' OR u.account_status=$3) AND ($4='all' OR u.identity_status=$4)
      ORDER BY u.created_at DESC LIMIT 200`, [q, pattern, account, verification]);
    res.json(rows);
  } catch (e) { next(e); }
});

app.patch('/api/admin/users/:id/status', auth, allow('admin'), async (req, res, next) => {
  try {
    const status = String(req.body.status || '');
    const reason = String(req.body.reason || '').trim().slice(0,200);
    if (!['active','suspended'].includes(status)) return res.status(400).json({ error: 'Estado de cuenta inválido' });
    if (status === 'suspended' && reason.length < 3) return res.status(400).json({ error: 'Debes indicar un motivo para suspender la cuenta' });
    if (String(req.params.id) === String(req.user.id)) return res.status(400).json({ error: 'No puedes suspender tu propia cuenta admin' });
    const user = await withTransaction(async (client) => {
      const { rows } = await client.query(`UPDATE users SET account_status=$1 WHERE id=$2 AND role='user'
        RETURNING id,name,email,account_status AS "accountStatus"`, [status, req.params.id]);
      if (!rows[0]) return null;
      await client.query(`INSERT INTO admin_actions(admin_id,action,target_type,target_id,reason) VALUES($1,$2,'user',$3,$4)`,
        [req.user.id, status === 'suspended' ? 'user_suspended' : 'user_reactivated', req.params.id, reason || 'Cuenta reactivada por administrador']);
      return rows[0];
    });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(user);
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