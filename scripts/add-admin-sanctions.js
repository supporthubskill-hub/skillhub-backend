const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');
let source = fs.readFileSync(serverPath, 'utf8');

function replaceOrThrow(needle, replacement, label) {
  if (!source.includes(needle)) throw new Error(`Admin sanctions patch failed: ${label}`);
  source = source.replace(needle, replacement);
}

replaceOrThrow(
  "    CREATE INDEX IF NOT EXISTS idx_user_warnings_created ON user_warnings(created_at DESC);",
  "    CREATE INDEX IF NOT EXISTS idx_user_warnings_created ON user_warnings(created_at DESC);\n    ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_until TIMESTAMPTZ;\n    ALTER TABLE users ADD COLUMN IF NOT EXISTS suspension_reason TEXT NOT NULL DEFAULT '';\n    CREATE INDEX IF NOT EXISTS idx_users_suspended_until ON users(suspended_until);",
  'sanction schema'
);

replaceOrThrow(
  "    const { rows } = await pool.query('SELECT id,email,role,name,account_status,email_verified FROM users WHERE id=$1', [payload.id]);\n    const user = rows[0];\n    if (!user) return res.status(401).json({ error: 'Account not found' });\n    if (user.account_status === 'suspended') return res.status(403).json({ error: 'Account suspended' });",
  "    const { rows } = await pool.query('SELECT id,email,role,name,account_status,email_verified,suspended_until,suspension_reason FROM users WHERE id=$1', [payload.id]);\n    const user = rows[0];\n    if (!user) return res.status(401).json({ error: 'Account not found' });\n    if (user.account_status === 'suspended' && user.suspended_until && new Date(user.suspended_until).getTime() <= Date.now()) {\n      await pool.query(\"UPDATE users SET account_status='active',suspended_until=NULL,suspension_reason='' WHERE id=$1\", [user.id]);\n      user.account_status = 'active';\n      user.suspended_until = null;\n    }\n    if (user.account_status === 'suspended') return res.status(403).json({ error: 'Account suspended', suspendedUntil: user.suspended_until || null });",
  'auth suspension expiry'
);

replaceOrThrow(
  "    const user = rows[0];\n    if (!user || user.account_status === 'suspended' || !(await bcrypt.compare(String(req.body.password || ''), user.password_hash))) {",
  "    const user = rows[0];\n    if (user?.account_status === 'suspended' && user.suspended_until && new Date(user.suspended_until).getTime() <= Date.now()) {\n      await pool.query(\"UPDATE users SET account_status='active',suspended_until=NULL,suspension_reason='' WHERE id=$1\", [user.id]);\n      user.account_status = 'active';\n      user.suspended_until = null;\n    }\n    if (!user || user.account_status === 'suspended' || !(await bcrypt.compare(String(req.body.password || ''), user.password_hash))) {",
  'login suspension expiry'
);

replaceOrThrow(
  "    const status = String(req.body.status || '');\n    const reason = String(req.body.reason || '').trim().slice(0,200);",
  "    const status = String(req.body.status || '');\n    const reason = String(req.body.reason || '').trim().slice(0,200);\n    const durationHoursRaw = req.body.durationHours;\n    const durationHours = durationHoursRaw === null || durationHoursRaw === undefined || durationHoursRaw === '' ? null : Number(durationHoursRaw);\n    if (status === 'suspended' && durationHours !== null && (!Number.isFinite(durationHours) || durationHours < 1 || durationHours > 24 * 365)) return res.status(400).json({ error: 'Duración de suspensión inválida' });",
  'status duration validation'
);

replaceOrThrow(
  "      const { rows } = await client.query(`UPDATE users SET account_status=$1 WHERE id=$2 AND role='user'\n        RETURNING id,name,email,account_status AS \"accountStatus\"`, [status, req.params.id]);",
  "      const suspendedUntil = status === 'suspended' && durationHours !== null ? new Date(Date.now() + durationHours * 60 * 60 * 1000) : null;\n      const { rows } = await client.query(`UPDATE users SET account_status=$1,suspended_until=$2,suspension_reason=$3 WHERE id=$4 AND role='user'\n        RETURNING id,name,email,account_status AS \"accountStatus\",suspended_until AS \"suspendedUntil\"`, [status, suspendedUntil, status === 'suspended' ? reason : '', req.params.id]);",
  'status persistence'
);

replaceOrThrow(
  "      await client.query(`INSERT INTO admin_actions(admin_id,action,target_type,target_id,reason) VALUES($1,$2,'user',$3,$4)`,\n        [req.user.id, status === 'suspended' ? 'user_suspended' : 'user_reactivated', req.params.id, reason || 'Cuenta reactivada por administrador']);\n      return rows[0];",
  "      const untilText = rows[0].suspendedUntil ? ` hasta ${new Date(rows[0].suspendedUntil).toLocaleString('es-US')}` : '';\n      const auditReason = status === 'suspended' ? `${reason}${untilText}` : (reason || 'Cuenta reactivada por administrador');\n      await client.query(`INSERT INTO admin_actions(admin_id,action,target_type,target_id,reason) VALUES($1,$2,'user',$3,$4)`,\n        [req.user.id, status === 'suspended' ? 'user_suspended' : 'user_reactivated', req.params.id, auditReason]);\n      await client.query(`INSERT INTO user_notifications(user_id,title,body) VALUES($1,$2,$3)`, [req.params.id, status === 'suspended' ? 'Cuenta suspendida en Zeqviro' : 'Cuenta reactivada en Zeqviro', status === 'suspended' ? `Tu cuenta fue suspendida${untilText}. Motivo: ${reason}` : 'Tu cuenta fue reactivada y ya puedes volver a usar Zeqviro.']);\n      return rows[0];",
  'sanction audit notification'
);

fs.writeFileSync(serverPath, source, 'utf8');
console.log('Admin sanctions applied');
