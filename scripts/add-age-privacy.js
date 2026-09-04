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

const authSelect = "    const { rows } = await pool.query('SELECT id,email,role,name,account_status,email_verified FROM users WHERE id=$1', [payload.id]);";
const authSelectNew = "    const { rows } = await pool.query('SELECT id,email,role,name,account_status,email_verified,age_band FROM users WHERE id=$1', [payload.id]);";
replaceOnce(authSelect, authSelectNew, 'auth user age band');

const oldRegister = `app.post('/api/auth/register', async (req, res, next) => {\n  try {\n    const email = cleanEmail(req.body.email);\n    const password = String(req.body.password || '');\n    const name = String(req.body.name || '').trim();\n    const role = 'user';\n    if (!validEmail(email) || password.length < 8 || password.length > 128 || name.length < 2 || name.length > 80) {\n      return res.status(400).json({ error: 'Check name, email, and password (minimum 8 characters)' });\n    }\n    const hash = await bcrypt.hash(password, 12);\n    const { rows } = await pool.query(\n      'INSERT INTO users(email,password_hash,role,name) VALUES($1,$2,$3,$4) RETURNING id,email,role,name',\n      [email, hash, role, name]\n    );\n    const user = rows[0];\n    const token = jwt.sign(publicUser(user), process.env.JWT_SECRET, { expiresIn: '2h', issuer: 'skillhub' });\n    res.status(201).json({ token, user: publicUser(user) });\n  } catch (e) {\n    if (e.code === '23505') return res.status(409).json({ error: 'Email already registered' });\n    next(e);\n  }\n});`;

const newRegister = `app.post('/api/auth/register', async (req, res, next) => {\n  try {\n    const email = cleanEmail(req.body.email);\n    const password = String(req.body.password || '');\n    const name = String(req.body.name || '').trim();\n    const birthDate = String(req.body.birthDate || '').trim();\n    const region = String(req.body.region || 'OTHER').trim().slice(0, 32) || 'OTHER';\n    const privacyAcceptedAt = String(req.body.privacyAcceptedAt || '').trim();\n    const role = 'user';\n    const age = calculateAge(birthDate);\n    const ageBand = ageBandFor(age);\n    const acceptedAt = new Date(privacyAcceptedAt);\n\n    if (!validEmail(email) || password.length < 8 || password.length > 128 || name.length < 2 || name.length > 80) {\n      return res.status(400).json({ error: 'Check name, email, and password (minimum 8 characters)' });\n    }\n    if (!Number.isInteger(age) || age < 14 || age > 100 || !ageBand || ageBand === 'under_14') {\n      return res.status(400).json({ error: 'Durante la beta debes tener al menos 14 años para crear una cuenta.', code: 'AGE_NOT_ELIGIBLE' });\n    }\n    if (!privacyAcceptedAt || Number.isNaN(acceptedAt.getTime()) || acceptedAt.getTime() > Date.now() + 5 * 60 * 1000) {\n      return res.status(400).json({ error: 'Debes aceptar los Términos, Privacidad y Normas para crear la cuenta.', code: 'PRIVACY_CONSENT_REQUIRED' });\n    }\n\n    const hash = await bcrypt.hash(password, 12);\n    const { rows } = await pool.query(\n      'INSERT INTO users(email,password_hash,role,name,birth_date,age_band,region,privacy_accepted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,email,role,name,email_verified,age_band',\n      [email, hash, role, name, birthDate, ageBand, region, acceptedAt.toISOString()]\n    );\n    const user = rows[0];\n    const token = jwt.sign(publicUser(user), process.env.JWT_SECRET, { expiresIn: '2h', issuer: 'skillhub' });\n    res.status(201).json({ token, user: publicUser(user) });\n  } catch (e) {\n    if (e.code === '23505') return res.status(409).json({ error: 'Email already registered' });\n    next(e);\n  }\n});`;
replaceOnce(oldRegister, newRegister, 'registration route');

fs.writeFileSync(serverPath, source, 'utf8');
console.log('Age and privacy backend patch applied');
