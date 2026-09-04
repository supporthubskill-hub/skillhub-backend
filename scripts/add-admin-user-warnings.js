const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');
let source = fs.readFileSync(serverPath, 'utf8');

function replaceOrThrow(needle, replacement, label) {
  if (!source.includes(needle)) throw new Error(`Admin user warnings patch failed: ${label}`);
  source = source.replace(needle, replacement);
}

replaceOrThrow(
  "    CREATE INDEX IF NOT EXISTS idx_admin_notification_campaigns_created ON admin_notification_campaigns(created_at DESC);",
  "    CREATE INDEX IF NOT EXISTS idx_admin_notification_campaigns_created ON admin_notification_campaigns(created_at DESC);\n    CREATE TABLE IF NOT EXISTS user_warnings (\n      id BIGSERIAL PRIMARY KEY,\n      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,\n      admin_id BIGINT REFERENCES users(id) ON DELETE SET NULL,\n      category VARCHAR(80) NOT NULL,\n      message TEXT NOT NULL,\n      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','resolved')),\n      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),\n      resolved_at TIMESTAMPTZ\n    );\n    CREATE INDEX IF NOT EXISTS idx_user_warnings_user_created ON user_warnings(user_id, created_at DESC);\n    CREATE INDEX IF NOT EXISTS idx_user_warnings_created ON user_warnings(created_at DESC);",
  'warning schema'
);

const routes = `app.get('/api/admin/warnings', auth, allow('admin'), async (req, res, next) => {
  try {
    const userId = Number(req.query.userId || 0);
    const params = [];
    let where = '';
    if (Number.isInteger(userId) && userId > 0) { params.push(userId); where = 'WHERE w.user_id=$1'; }
    const { rows } = await pool.query(\`SELECT w.id,w.user_id AS "userId",u.name AS "userName",u.email AS "userEmail",w.category,w.message,w.status,w.created_at AS "createdAt"
      FROM user_warnings w JOIN users u ON u.id=w.user_id \${where}
      ORDER BY w.created_at DESC LIMIT 100\`, params);
    res.json(rows);
  } catch (e) { next(e); }
});

app.post('/api/admin/warnings', auth, allow('admin'), async (req, res, next) => {
  try {
    const userId = Number(req.body.userId);
    const category = String(req.body.category || '').trim().slice(0, 80);
    const message = String(req.body.message || '').trim().slice(0, 1500);
    if (!Number.isInteger(userId) || userId < 1) return res.status(400).json({ error: 'Selecciona un usuario' });
    if (category.length < 2) return res.status(400).json({ error: 'Selecciona un motivo' });
    if (message.length < 4) return res.status(400).json({ error: 'Escribe una explicación breve' });

    const warning = await withTransaction(async (client) => {
      const { rows: users } = await client.query("SELECT id,name,email FROM users WHERE id=$1 AND role <> 'admin' LIMIT 1", [userId]);
      if (!users[0]) { const err = new Error('Usuario no encontrado'); err.statusCode = 404; throw err; }
      const { rows } = await client.query(\`INSERT INTO user_warnings(user_id,admin_id,category,message)
        VALUES($1,$2,$3,$4) RETURNING id,user_id AS "userId",category,message,status,created_at AS "createdAt"\`,
        [userId, req.user.id, category, message]);
      await client.query(\`INSERT INTO user_notifications(user_id,title,body)
        VALUES($1,$2,$3)\`, [userId, 'Advertencia de Zeqviro', \`\${category}: \${message}\`]);
      return { ...rows[0], userName: users[0].name, userEmail: users[0].email };
    });

    pool.query(\`INSERT INTO admin_actions(admin_id,action,target_type,target_id,reason)
      VALUES($1,'user_warning_sent','user',$2,$3)\`, [req.user.id, userId, \`\${category}: \${message.slice(0, 300)}\`]).catch(() => {});

    res.status(201).json({ warning, message: 'Advertencia registrada y notificada al usuario.' });
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
    next(e);
  }
});

app.patch('/api/admin/warnings/:id/resolve', auth, allow('admin'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(\`UPDATE user_warnings SET status='resolved',resolved_at=NOW()
      WHERE id=$1 AND status='active' RETURNING id,status,resolved_at AS "resolvedAt"\`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Advertencia no encontrada o ya resuelta' });
    res.json(rows[0]);
  } catch (e) { next(e); }
});

`;

replaceOrThrow(
  "app.get('/api/admin/activity', auth, allow('admin'), async (_req, res, next) => {",
  routes + "app.get('/api/admin/activity', auth, allow('admin'), async (_req, res, next) => {",
  'warning routes'
);

fs.writeFileSync(serverPath, source, 'utf8');
console.log('Admin user warnings applied');
