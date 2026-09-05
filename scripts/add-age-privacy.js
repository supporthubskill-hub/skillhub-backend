const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');
let source = fs.readFileSync(serverPath, 'utf8');

function replaceOnce(needle, replacement, label) {
  if (source.includes(replacement)) return;
  if (!source.includes(needle)) throw new Error(`Age/privacy patch failed: ${label}`);
  source = source.replace(needle, replacement);
}

const oldPublicUser = "const publicUser = (u) => ({ id: u.id, email: u.email, role: u.role, name: u.name, emailVerified: Boolean(u.email_verified) });";
const newPublicUser = `const publicUser = (u) => ({ id: u.id, email: u.email, role: u.role, name: u.name, emailVerified: Boolean(u.email_verified), ageBand: u.age_band || null });\n\nconst calculateAge = (birthDate) => {\n  const value = String(birthDate || '').trim();\n  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(value)) return null;\n  const date = new Date(\`${'${value}'}T00:00:00Z\`);\n  if (Number.isNaN(date.getTime())) return null;\n  const [year, month, day] = value.split('-').map(Number);\n  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null;\n  const now = new Date();\n  let age = now.getUTCFullYear() - year;\n  const monthDiff = now.getUTCMonth() + 1 - month;\n  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < day)) age -= 1;\n  return age;\n};\n\nconst ageBandFor = (age) => {\n  if (!Number.isInteger(age)) return null;\n  if (age < 14) return 'under_14';\n  if (age <= 15) return '14_15';\n  if (age <= 17) return '16_17';\n  return '18_plus';\n};`;
replaceOnce(oldPublicUser, newPublicUser, 'public user helper');

const accountStatusColumn = "    ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status TEXT NOT NULL DEFAULT 'active';";
const ageColumns = `${accountStatusColumn}\n    ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_date DATE;\n    ALTER TABLE users ADD COLUMN IF NOT EXISTS age_band TEXT;\n    ALTER TABLE users ADD COLUMN IF NOT EXISTS region TEXT NOT NULL DEFAULT 'OTHER';\n    ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_accepted_at TIMESTAMPTZ;\n    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_age_band_check;\n    ALTER TABLE users ADD CONSTRAINT users_age_band_check CHECK (age_band IS NULL OR age_band IN ('14_15','16_17','18_plus'));`;
replaceOnce(accountStatusColumn, ageColumns, 'user age/privacy columns');

const authSelect = "    const { rows } = await pool.query('SELECT id,email,role,name,account_status,email_verified,suspended_until,suspension_reason FROM users WHERE id=$1', [payload.id]);";
const authSelectNew = "    const { rows } = await pool.query('SELECT id,email,role,name,account_status,email_verified,suspended_until,suspension_reason,age_band FROM users WHERE id=$1', [payload.id]);";
replaceOnce(authSelect, authSelectNew, 'auth user age band');

const adminUsersSelect = `    const { rows } = await pool.query(\`SELECT u.id,u.name,u.email,u.role,u.account_status AS "accountStatus",
      u.identity_status AS "identityStatus",u.created_at AS "createdAt",
      (SELECT COUNT(*)::int FROM services s WHERE s.provider_id=u.id) AS "serviceCount"
      FROM users u WHERE ($1='' OR u.name ILIKE $2 OR u.email ILIKE $2)`;
const adminUsersSelectNew = `    const { rows } = await pool.query(\`SELECT u.id,u.name,u.email,u.role,u.account_status AS "accountStatus",
      u.identity_status AS "identityStatus",u.age_band AS "ageBand",u.created_at AS "createdAt",
      (SELECT COUNT(*)::int FROM services s WHERE s.provider_id=u.id) AS "serviceCount"
      FROM users u WHERE ($1='' OR u.name ILIKE $2 OR u.email ILIKE $2)`;
replaceOnce(adminUsersSelect, adminUsersSelectNew, 'admin user list age band');

const adminUserDetailSelect = `    const { rows: users } = await pool.query(\`SELECT id,name,email,role,account_status AS "accountStatus",identity_status AS "identityStatus",
      email_verified AS "emailVerified",phone_verified AS "phoneVerified",headline,bio,skills,languages,location,experience,portfolio_url AS "portfolioUrl",created_at AS "createdAt"
      FROM users WHERE id=$1\`, [req.params.id]);`;
const adminUserDetailSelectNew = `    const { rows: users } = await pool.query(\`SELECT id,name,email,role,account_status AS "accountStatus",identity_status AS "identityStatus",age_band AS "ageBand",
      email_verified AS "emailVerified",phone_verified AS "phoneVerified",headline,bio,skills,languages,location,experience,portfolio_url AS "portfolioUrl",created_at AS "createdAt"
      FROM users WHERE id=$1\`, [req.params.id]);`;
replaceOnce(adminUserDetailSelect, adminUserDetailSelectNew, 'admin user detail age band');

const oldRegister = `app.post('/api/auth/register', async (req, res, next) => {
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

const newRegister = `app.post('/api/auth/register', async (req, res, next) => {
  try {
    const email = cleanEmail(req.body.email);
    const password = String(req.body.password || '');
    const name = String(req.body.name || '').trim();
    const verificationToken = String(req.body.verificationToken || '').trim();
    const birthDate = String(req.body.birthDate || '').trim();
    const region = req.body.region === 'NY' ? 'NY' : 'OTHER';
    const privacyAccepted = req.body.privacyAccepted === true;
    const role = 'user';
    const age = calculateAge(birthDate);
    const ageBand = ageBandFor(age);

    if (!validEmail(email) || password.length < 8 || password.length > 128 || name.length < 2 || name.length > 80) {
      return res.status(400).json({ error: 'Revisa nombre, correo y contraseña (mínimo 8 caracteres).' });
    }
    if (!verificationToken) return res.status(403).json({ error: 'Debes verificar tu correo antes de crear la cuenta.' });
    if (!Number.isInteger(age) || age < 14 || age > 100 || !ageBand || ageBand === 'under_14') {
      return res.status(400).json({ error: 'Durante la beta debes tener al menos 14 años para crear una cuenta.', code: 'AGE_NOT_ELIGIBLE' });
    }
    if (!privacyAccepted) {
      return res.status(400).json({ error: 'Debes aceptar los Términos, Privacidad y Normas para crear la cuenta.', code: 'PRIVACY_CONSENT_REQUIRED' });
    }

    const privacyAcceptedAt = new Date().toISOString();
    const hash = await bcrypt.hash(password, 12);
    const user = await withTransaction(async (client) => {
      const { rows: verificationRows } = await client.query('SELECT * FROM preregistration_email_codes WHERE email=$1 FOR UPDATE', [email]);
      const verification = verificationRows[0];
      if (!verification || !verification.verified_at || !verification.token_expires_at) return null;
      if (new Date(verification.token_expires_at).getTime() < Date.now()) return null;
      if (verification.verification_token_hash !== hashRegistrationSecret(verificationToken)) return null;

      const { rows } = await client.query(
        'INSERT INTO users(email,password_hash,role,name,email_verified,birth_date,age_band,region,privacy_accepted_at) VALUES($1,$2,$3,$4,TRUE,$5,$6,$7,$8) RETURNING id,email,role,name,email_verified,age_band',
        [email, hash, role, name, birthDate, ageBand, region, privacyAcceptedAt]
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
replaceOnce(oldRegister, newRegister, 'verified registration route');

fs.writeFileSync(serverPath, source, 'utf8');
console.log('Age and privacy backend patch applied');
