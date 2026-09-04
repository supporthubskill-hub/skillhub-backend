const fs = require('fs');
const path = require('path');

const sourcePath = path.join(__dirname, '..', 'server.js');

function replaceOrThrow(source, needle, replacement, label) {
  if (!source.includes(needle)) throw new Error(`Password recovery patch failed: ${label}`);
  return source.replace(needle, replacement);
}

let source = fs.readFileSync(sourcePath, 'utf8');

source = replaceOrThrow(
  source,
  "    CREATE TABLE IF NOT EXISTS platform_settings (",
  `    CREATE TABLE IF NOT EXISTS password_reset_codes (
      email TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reset_token_hash TEXT,
      token_expires_at TIMESTAMPTZ,
      verified_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_password_reset_expires ON password_reset_codes(expires_at);
    CREATE TABLE IF NOT EXISTS platform_settings (`,
  'password reset table'
);

const mailNeedle = `async function sendVerificationMail(email, code) {
  const transporter = createMailTransport();
  const from = process.env.EMAIL_FROM || \`SkillHub <\${process.env.SMTP_USER}>\`;
  await transporter.sendMail({
    from,
    to: email,
    subject: 'Tu código de verificación de SkillHub',
    text: \`Tu código de verificación de SkillHub es \${code}. Expira en 10 minutos. Si no solicitaste este código, ignora este correo.\`,
    html: \`<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px"><h2>Verifica tu correo en SkillHub</h2><p>Usa este código para confirmar tu correo:</p><div style="font-size:32px;font-weight:700;letter-spacing:8px;margin:24px 0">\${code}</div><p>El código expira en 10 minutos.</p><p style="color:#64748b;font-size:13px">Si no solicitaste este código, puedes ignorar este mensaje.</p></div>\`
  });
}`;

const mailReplacement = mailNeedle + `

async function sendPasswordResetMail(email, code) {
  const transporter = createMailTransport();
  const from = process.env.EMAIL_FROM || \`SkillHub <\${process.env.SMTP_USER}>\`;
  await transporter.sendMail({
    from,
    to: email,
    subject: 'Restablece tu contraseña de SkillHub',
    text: \`Tu código para restablecer la contraseña de SkillHub es \${code}. Expira en 10 minutos. Si no solicitaste este cambio, ignora este correo.\`,
    html: \`<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px"><h2>Restablece tu contraseña</h2><p>Usa este código para continuar:</p><div style="font-size:32px;font-weight:700;letter-spacing:8px;margin:24px 0">\${code}</div><p>El código expira en 10 minutos.</p><p style="color:#64748b;font-size:13px">Si no solicitaste este cambio, puedes ignorar este mensaje.</p></div>\`
  });
}`;

source = replaceOrThrow(source, mailNeedle, mailReplacement, 'password reset email helper');

const loginNeedle = "app.post('/api/auth/login', async (req, res, next) => {";
const recoveryRoutes = `app.post('/api/auth/password/forgot', verificationLimiter, async (req, res, next) => {
  try {
    const email = cleanEmail(req.body.email);
    if (!validEmail(email)) return res.status(400).json({ error: 'Ingresa un correo válido.' });

    const generic = { sent: true, expiresInSeconds: 600, message: 'Si existe una cuenta con ese correo, recibirás un código para restablecer tu contraseña.' };
    const { rows: userRows } = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
    if (!userRows[0]) return res.json(generic);

    const { rows: existingRows } = await pool.query('SELECT last_sent_at FROM password_reset_codes WHERE email=$1', [email]);
    const lastSent = existingRows[0]?.last_sent_at ? new Date(existingRows[0].last_sent_at).getTime() : 0;
    const remainingMs = 60_000 - (Date.now() - lastSent);
    if (remainingMs > 0) return res.status(429).json({ error: \`Espera \${Math.ceil(remainingMs / 1000)} segundos antes de pedir otro código.\` });

    const code = String(crypto.randomInt(100000, 1000000));
    const codeHash = hashRegistrationSecret(code);
    await pool.query(\`INSERT INTO password_reset_codes(email,code_hash,expires_at,attempts,last_sent_at,reset_token_hash,token_expires_at,verified_at)
      VALUES($1,$2,NOW() + INTERVAL '10 minutes',0,NOW(),NULL,NULL,NULL)
      ON CONFLICT(email) DO UPDATE SET code_hash=EXCLUDED.code_hash,expires_at=EXCLUDED.expires_at,attempts=0,last_sent_at=NOW(),reset_token_hash=NULL,token_expires_at=NULL,verified_at=NULL\`,
      [email, codeHash]);

    try {
      await sendPasswordResetMail(email, code);
    } catch (mailError) {
      await pool.query('DELETE FROM password_reset_codes WHERE email=$1 AND code_hash=$2', [email, codeHash]);
      throw mailError;
    }

    res.json(generic);
  } catch (e) { next(e); }
});

app.post('/api/auth/password/confirm', verificationLimiter, async (req, res, next) => {
  try {
    const email = cleanEmail(req.body.email);
    const code = String(req.body.code || '').trim();
    if (!validEmail(email) || !/^\\d{6}$/.test(code)) return res.status(400).json({ error: 'Correo o código inválido.' });

    const result = await withTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM password_reset_codes WHERE email=$1 FOR UPDATE', [email]);
      const record = rows[0];
      if (!record) return { status: 'invalid' };
      if (new Date(record.expires_at).getTime() < Date.now()) {
        await client.query('DELETE FROM password_reset_codes WHERE email=$1', [email]);
        return { status: 'expired' };
      }
      if (record.attempts >= 5) {
        await client.query('DELETE FROM password_reset_codes WHERE email=$1', [email]);
        return { status: 'locked' };
      }
      if (hashRegistrationSecret(code) !== record.code_hash) {
        await client.query('UPDATE password_reset_codes SET attempts=attempts+1 WHERE email=$1', [email]);
        return { status: 'invalid' };
      }
      const resetToken = crypto.randomBytes(32).toString('hex');
      await client.query(\`UPDATE password_reset_codes
        SET reset_token_hash=$1,token_expires_at=NOW() + INTERVAL '15 minutes',verified_at=NOW(),attempts=0
        WHERE email=$2\`, [hashRegistrationSecret(resetToken), email]);
      return { status: 'ok', resetToken };
    });

    if (result.status === 'ok') return res.json({ verified: true, resetToken: result.resetToken, expiresInSeconds: 900, message: 'Código confirmado. Ya puedes crear una contraseña nueva.' });
    if (result.status === 'expired') return res.status(400).json({ error: 'El código expiró. Solicita uno nuevo.' });
    if (result.status === 'locked') return res.status(429).json({ error: 'Demasiados intentos. Solicita un código nuevo.' });
    return res.status(400).json({ error: 'Código incorrecto o inválido.' });
  } catch (e) { next(e); }
});

app.post('/api/auth/password/reset', verificationLimiter, async (req, res, next) => {
  try {
    const email = cleanEmail(req.body.email);
    const password = String(req.body.password || '');
    const resetToken = String(req.body.resetToken || '').trim();
    if (!validEmail(email) || password.length < 8 || password.length > 128 || !resetToken) {
      return res.status(400).json({ error: 'Revisa el correo, el código confirmado y la contraseña (mínimo 8 caracteres).' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const changed = await withTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM password_reset_codes WHERE email=$1 FOR UPDATE', [email]);
      const record = rows[0];
      if (!record || !record.verified_at || !record.token_expires_at) return false;
      if (new Date(record.token_expires_at).getTime() < Date.now()) return false;
      if (record.reset_token_hash !== hashRegistrationSecret(resetToken)) return false;
      const update = await client.query('UPDATE users SET password_hash=$1 WHERE email=$2', [passwordHash, email]);
      if (!update.rowCount) return false;
      await client.query('DELETE FROM password_reset_codes WHERE email=$1', [email]);
      return true;
    });

    if (!changed) return res.status(403).json({ error: 'La autorización para cambiar la contraseña no es válida o expiró.' });
    res.json({ reset: true, message: 'Contraseña actualizada. Ya puedes iniciar sesión.' });
  } catch (e) { next(e); }
});

`;

source = replaceOrThrow(source, loginNeedle, recoveryRoutes + loginNeedle, 'password recovery routes');

fs.writeFileSync(sourcePath, source, 'utf8');
console.log('Password recovery patch applied');
