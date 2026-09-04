from pathlib import Path
import json

server_path = Path('server.js')
text = server_path.read_text()

# Imports
anchor = "const jwt = require('jsonwebtoken');\n"
if "require('nodemailer')" not in text:
    text = text.replace(anchor, anchor + "const crypto = require('crypto');\nconst nodemailer = require('nodemailer');\n", 1)

# Rate limiter dedicated to verification attempts
anchor = "app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }));\n"
if "verificationLimiter" not in text:
    text = text.replace(anchor, anchor + "const verificationLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: true, legacyHeaders: false });\n", 1)

# Public session user includes email verification state
text = text.replace(
    "const publicUser = (u) => ({ id: u.id, email: u.email, role: u.role, name: u.name });",
    "const publicUser = (u) => ({ id: u.id, email: u.email, role: u.role, name: u.name, emailVerified: Boolean(u.email_verified) });"
)

# Verification table
anchor = "    CREATE TABLE IF NOT EXISTS admin_actions (\n"
verification_table = """    CREATE TABLE IF NOT EXISTS email_verification_codes (\n      user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,\n      code_hash TEXT NOT NULL,\n      expires_at TIMESTAMPTZ NOT NULL,\n      attempts INTEGER NOT NULL DEFAULT 0,\n      last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()\n    );\n    CREATE INDEX IF NOT EXISTS idx_email_verification_expires ON email_verification_codes(expires_at);\n"""
if "CREATE TABLE IF NOT EXISTS email_verification_codes" not in text:
    text = text.replace(anchor, verification_table + anchor, 1)

# Auth reload must include email_verified
text = text.replace(
    "SELECT id,email,role,name,account_status FROM users WHERE id=$1",
    "SELECT id,email,role,name,account_status,email_verified FROM users WHERE id=$1"
)

# Helpers + endpoints before services routes
route_anchor = "app.get('/api/services', async (_req, res, next) => {\n"
if "app.post('/api/verification/email/send'" not in text:
    block = r'''const hashVerificationCode = (code) => crypto
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

'''
    text = text.replace(route_anchor, block + route_anchor, 1)

server_path.write_text(text)

# Add nodemailer dependency
package_path = Path('package.json')
pkg = json.loads(package_path.read_text())
pkg.setdefault('dependencies', {})['nodemailer'] = '^6.9.16'
package_path.write_text(json.dumps(pkg, indent=2) + '\n')

# Document environment variables without secrets
env_path = Path('.env.example')
if env_path.exists():
    env = env_path.read_text()
    if 'SMTP_USER=' not in env:
        env += "\n# Email verification (Gmail SMTP or another SMTP provider)\nSMTP_HOST=smtp.gmail.com\nSMTP_PORT=465\nSMTP_SECURE=true\nSMTP_USER=\nSMTP_PASS=\nEMAIL_FROM=SkillHub <support@example.com>\n"
        env_path.write_text(env)

print('Email verification patch applied')
