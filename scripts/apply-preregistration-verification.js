const fs = require('fs');
const path = require('path');

const sourcePath = path.join(__dirname, '..', 'server.js');

function replaceOrThrow(source, needle, replacement, label) {
  if (!source.includes(needle)) throw new Error(`Pre-registration patch failed: ${label}`);
  return source.replace(needle, replacement);
}

let source = fs.readFileSync(sourcePath, 'utf8');

source = replaceOrThrow(
  source,
  "    CREATE TABLE IF NOT EXISTS platform_settings (",
  `    CREATE TABLE IF NOT EXISTS preregistration_email_codes (
      email TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      verification_token_hash TEXT,
      token_expires_at TIMESTAMPTZ,
      verified_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_preregistration_email_expires ON preregistration_email_codes(expires_at);
    CREATE TABLE IF NOT EXISTS platform_settings (`,
  'pre-registration table'
);

const oldRegister = `app.post('/api/auth/register', async (req, res, next) => {
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
});`;

const registrationFlow = `const hashRegistrationSecret = (value) => crypto
  .createHmac('sha256', process.env.JWT_SECRET)
  .update(String(value))
  .digest('hex');

app.post('/api/auth/register/email/send', verificationLimiter, async (req, res, next) => {
  try {
    const email = cleanEmail(req.body.email);
    if (!validEmail(email)) return res.status(400).json({ error: 'Ingresa un correo válido.' });

    const { rows: userRows } = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
    if (userRows[0]) return res.status(409).json({ error: 'Ese correo ya está registrado.' });

    const { rows: existingRows } = await pool.query('SELECT last_sent_at FROM preregistration_email_codes WHERE email=$1', [email]);
    const lastSent = existingRows[0]?.last_sent_at ? new Date(existingRows[0].last_sent_at).getTime() : 0;
    const remainingMs = 60_000 - (Date.now() - lastSent);
    if (remainingMs > 0) return res.status(429).json({ error: \`Espera \${Math.ceil(remainingMs / 1000)} segundos antes de pedir otro código.\` });

    const code = String(crypto.randomInt(100000, 1000000));
    const codeHash = hashRegistrationSecret(code);
    await pool.query(\`INSERT INTO preregistration_email_codes(email,code_hash,expires_at,attempts,last_sent_at,verification_token_hash,token_expires_at,verified_at)
      VALUES($1,$2,NOW() + INTERVAL '10 minutes',0,NOW(),NULL,NULL,NULL)
      ON CONFLICT(email) DO UPDATE SET code_hash=EXCLUDED.code_hash,expires_at=EXCLUDED.expires_at,attempts=0,last_sent_at=NOW(),verification_token_hash=NULL,token_expires_at=NULL,verified_at=NULL\`,
      [email, codeHash]);

    try {
      await sendVerificationMail(email, code);
    } catch (mailError) {
      await pool.query('DELETE FROM preregistration_email_codes WHERE email=$1 AND code_hash=$2', [email, codeHash]);
      throw mailError;
    }

    res.json({ sent: true, expiresInSeconds: 600, message: 'Código enviado. Revisa tu correo.' });
  } catch (e) { next(e); }
});

app.post('/api/auth/register/email/confirm', verificationLimiter, async (req, res, next) => {
  try {
    const email = cleanEmail(req.body.email);
    const code = String(req.body.code || '').trim();
    if (!validEmail(email) || !/^\\d{6}$/.test(code)) return res.status(400).json({ error: 'Correo o código inválido.' });

    const result = await withTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM preregistration_email_codes WHERE email=$1 FOR UPDATE', [email]);
      const record = rows[0];
      if (!record) return { status: 'missing' };
      if (new Date(record.expires_at).getTime() < Date.now()) {
        await client.query('DELETE FROM preregistration_email_codes WHERE email=$1', [email]);
        return { status: 'expired' };
      }
      if (record.attempts >= 5) {
        await client.query('DELETE FROM preregistration_email_codes WHERE email=$1', [email]);
        return { status: 'locked' };
      }
      if (hashRegistrationSecret(code) !== record.code_hash) {
        await client.query('UPDATE preregistration_email_codes SET attempts=attempts+1 WHERE email=$1', [email]);
        return { status: 'invalid' };
      }

      const verificationToken = crypto.randomBytes(32).toString('hex');
      await client.query(\`UPDATE preregistration_email_codes
        SET verification_token_hash=$1,token_expires_at=NOW() + INTERVAL '15 minutes',verified_at=NOW(),attempts=0
        WHERE email=$2\`, [hashRegistrationSecret(verificationToken), email]);
      return { status: 'ok', verificationToken };
    });

    if (result.status === 'ok') return res.json({ verified: true, verificationToken: result.verificationToken, expiresInSeconds: 900, message: 'Correo verificado. Ya puedes crear tu cuenta.' });
    if (result.status === 'expired') return res.status(400).json({ error: 'El código expiró. Solicita uno nuevo.' });
    if (result.status === 'locked') return res.status(429).json({ error: 'Demasiados intentos. Solicita un código nuevo.' });
    if (result.status === 'missing') return res.status(400).json({ error: 'Primero solicita un código de verificación.' });
    return res.status(400).json({ error: 'Código incorrecto.' });
  } catch (e) { next(e); }
});

app.post('/api/auth/register', async (req, res, next) => {
  try {
    const email = cleanEmail(req.body.email);
    const password = String(req.body.password || '');
    const name = String(req.body.name || '').trim();
    const verificationToken = String(req.body.verificationToken || '').trim();
    const role = 'user';
    if (!validEmail(email) || password.length < 8 || password.length > 128 || name.length < 2 || name.length > 80) {
      return res.status(400).json({ error: 'Revisa nombre, correo y contraseña (mínimo 8 caracteres).' });
    }
    if (!verificationToken) return res.status(403).json({ error: 'Debes verificar tu correo antes de crear la cuenta.' });

    const hash = await bcrypt.hash(password, 12);
    const user = await withTransaction(async (client) => {
      const { rows: verificationRows } = await client.query('SELECT * FROM preregistration_email_codes WHERE email=$1 FOR UPDATE', [email]);
      const verification = verificationRows[0];
      if (!verification || !verification.verified_at || !verification.token_expires_at) return null;
      if (new Date(verification.token_expires_at).getTime() < Date.now()) return null;
      if (verification.verification_token_hash !== hashRegistrationSecret(verificationToken)) return null;

      const { rows } = await client.query(
        'INSERT INTO users(email,password_hash,role,name,email_verified) VALUES($1,$2,$3,$4,TRUE) RETURNING id,email,role,name,email_verified',
        [email, hash, role, name]
      );
      await client.query('DELETE FROM preregistration_email_codes WHERE email=$1', [email]);
      return rows[0];
    });

    if (!user) return res.status(403).json({ error: 'La verificación del correo no es válida o expiró. Verifica el correo nuevamente.' });
    const token = jwt.sign(publicUser(user), process.env.JWT_SECRET, { expiresIn: '2h', issuer: 'skillhub' });
    res.status(201).json({ token, user: publicUser(user) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email already registered' });
    next(e);
  }
});`;

source = replaceOrThrow(source, oldRegister, registrationFlow, 'registration flow');

fs.writeFileSync(sourcePath, source, 'utf8');
console.log('Pre-registration email verification patch applied');
