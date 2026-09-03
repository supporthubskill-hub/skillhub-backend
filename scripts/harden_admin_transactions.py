from pathlib import Path
p=Path('server.js')
s=p.read_text(encoding='utf-8')

marker="""const allow = (...roles) => (req, res, next) => roles.includes(req.user.role)
  ? next() : res.status(403).json({ error: 'Insufficient permissions' });
"""
helper="""const allow = (...roles) => (req, res, next) => roles.includes(req.user.role)
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
"""
if marker not in s: raise SystemExit('allow marker not found')
s=s.replace(marker, helper, 1)

old="""app.delete('/api/admin/services/:id', auth, allow('admin'), async (req, res, next) => {
  try {
    const reason = String(req.body.reason || '').trim().slice(0,200);
    if (reason.length < 3) return res.status(400).json({ error: 'Debes indicar un motivo para retirar el servicio' });
    const { rows } = await pool.query(`UPDATE services SET active=FALSE WHERE id=$1 AND active=TRUE
      RETURNING id,name,provider_id AS \"providerId\",active`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Servicio no encontrado o ya eliminado' });
    await pool.query('UPDATE availability SET available=FALSE WHERE service_id=$1 AND available=TRUE', [req.params.id]);
    await pool.query(`INSERT INTO admin_actions(admin_id,action,target_type,target_id,reason) VALUES($1,'service_removed','service',$2,$3)`, [req.user.id, req.params.id, reason]);
    res.json({ ...rows[0], removed: true, reason });
  } catch (e) { next(e); }
});
"""
new="""app.delete('/api/admin/services/:id', auth, allow('admin'), async (req, res, next) => {
  try {
    const reason = String(req.body.reason || '').trim().slice(0,200);
    if (reason.length < 3) return res.status(400).json({ error: 'Debes indicar un motivo para retirar el servicio' });
    const service = await withTransaction(async (client) => {
      const { rows } = await client.query(`UPDATE services SET active=FALSE WHERE id=$1 AND active=TRUE
        RETURNING id,name,provider_id AS \"providerId\",active`, [req.params.id]);
      if (!rows[0]) return null;
      await client.query('UPDATE availability SET available=FALSE WHERE service_id=$1 AND available=TRUE', [req.params.id]);
      await client.query(`INSERT INTO admin_actions(admin_id,action,target_type,target_id,reason) VALUES($1,'service_removed','service',$2,$3)`, [req.user.id, req.params.id, reason]);
      return rows[0];
    });
    if (!service) return res.status(404).json({ error: 'Servicio no encontrado o ya eliminado' });
    res.json({ ...service, removed: true, reason });
  } catch (e) { next(e); }
});
"""
if old not in s: raise SystemExit('service delete block not found')
s=s.replace(old,new,1)

old="""app.patch('/api/admin/services/:id/restore', auth, allow('admin'), async (req, res, next) => {
  try {
    const reason = String(req.body.reason || 'Restaurado por administrador').trim().slice(0,200);
    const { rows } = await pool.query(`UPDATE services SET active=TRUE WHERE id=$1 AND active=FALSE
      RETURNING id,name,provider_id AS \"providerId\",active`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Servicio no encontrado o ya está activo' });
    await pool.query(`INSERT INTO admin_actions(admin_id,action,target_type,target_id,reason) VALUES($1,'service_restored','service',$2,$3)`, [req.user.id, req.params.id, reason]);
    res.json({ ...rows[0], restored: true });
  } catch (e) { next(e); }
});
"""
new="""app.patch('/api/admin/services/:id/restore', auth, allow('admin'), async (req, res, next) => {
  try {
    const reason = String(req.body.reason || 'Restaurado por administrador').trim().slice(0,200);
    const service = await withTransaction(async (client) => {
      const { rows } = await client.query(`UPDATE services SET active=TRUE WHERE id=$1 AND active=FALSE
        RETURNING id,name,provider_id AS \"providerId\",active`, [req.params.id]);
      if (!rows[0]) return null;
      await client.query(`INSERT INTO admin_actions(admin_id,action,target_type,target_id,reason) VALUES($1,'service_restored','service',$2,$3)`, [req.user.id, req.params.id, reason]);
      return rows[0];
    });
    if (!service) return res.status(404).json({ error: 'Servicio no encontrado o ya está activo' });
    res.json({ ...service, restored: true });
  } catch (e) { next(e); }
});
"""
if old not in s: raise SystemExit('service restore block not found')
s=s.replace(old,new,1)

old="""    const { rows } = await pool.query(`UPDATE users SET account_status=$1 WHERE id=$2 AND role='user'
      RETURNING id,name,email,account_status AS \"accountStatus\"`, [status, req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
    await pool.query(`INSERT INTO admin_actions(admin_id,action,target_type,target_id,reason) VALUES($1,$2,'user',$3,$4)`,
      [req.user.id, status === 'suspended' ? 'user_suspended' : 'user_reactivated', req.params.id, reason || 'Cuenta reactivada por administrador']);
    res.json(rows[0]);
"""
new="""    const user = await withTransaction(async (client) => {
      const { rows } = await client.query(`UPDATE users SET account_status=$1 WHERE id=$2 AND role='user'
        RETURNING id,name,email,account_status AS \"accountStatus\"`, [status, req.params.id]);
      if (!rows[0]) return null;
      await client.query(`INSERT INTO admin_actions(admin_id,action,target_type,target_id,reason) VALUES($1,$2,'user',$3,$4)`,
        [req.user.id, status === 'suspended' ? 'user_suspended' : 'user_reactivated', req.params.id, reason || 'Cuenta reactivada por administrador']);
      return rows[0];
    });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(user);
"""
if old not in s: raise SystemExit('user status block not found')
s=s.replace(old,new,1)

idx="""    CREATE TABLE IF NOT EXISTS admin_actions (
      id BIGSERIAL PRIMARY KEY,
      admin_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id BIGINT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
"""
idx_new=idx+"""    CREATE INDEX IF NOT EXISTS idx_admin_actions_created_at ON admin_actions(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_users_account_identity ON users(account_status, identity_status);
    CREATE INDEX IF NOT EXISTS idx_services_active_created ON services(active, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_reports_status_created ON reports(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_disputes_status_created ON disputes(status, created_at DESC);
"""
if idx not in s: raise SystemExit('admin_actions table block not found')
s=s.replace(idx,idx_new,1)

p.write_text(s,encoding='utf-8')
