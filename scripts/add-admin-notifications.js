const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');
let source = fs.readFileSync(serverPath, 'utf8');

function replaceOrThrow(needle, replacement, label) {
  if (!source.includes(needle)) throw new Error(`Admin notifications patch failed: ${label}`);
  source = source.replace(needle, replacement);
}

replaceOrThrow(
  "    CREATE INDEX IF NOT EXISTS idx_service_request_blocks_provider ON service_request_blocks(provider_id, created_at DESC);",
  "    CREATE INDEX IF NOT EXISTS idx_service_request_blocks_provider ON service_request_blocks(provider_id, created_at DESC);\n    CREATE TABLE IF NOT EXISTS admin_notification_campaigns (\n      id BIGSERIAL PRIMARY KEY,\n      admin_id BIGINT REFERENCES users(id) ON DELETE SET NULL,\n      audience TEXT NOT NULL CHECK (audience IN ('user','all')),\n      target_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,\n      title VARCHAR(120) NOT NULL,\n      body TEXT NOT NULL,\n      recipient_count INTEGER NOT NULL DEFAULT 0,\n      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()\n    );\n    CREATE TABLE IF NOT EXISTS user_notifications (\n      id BIGSERIAL PRIMARY KEY,\n      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,\n      campaign_id BIGINT REFERENCES admin_notification_campaigns(id) ON DELETE SET NULL,\n      title VARCHAR(120) NOT NULL,\n      body TEXT NOT NULL,\n      read_at TIMESTAMPTZ,\n      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()\n    );\n    CREATE INDEX IF NOT EXISTS idx_user_notifications_user_created ON user_notifications(user_id, created_at DESC);\n    CREATE INDEX IF NOT EXISTS idx_user_notifications_unread ON user_notifications(user_id, read_at) WHERE read_at IS NULL;\n    CREATE INDEX IF NOT EXISTS idx_admin_notification_campaigns_created ON admin_notification_campaigns(created_at DESC);",
  'notification schema'
);

const routes = `app.get('/api/notifications', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(\`SELECT id,title,body,read_at AS "readAt",created_at AS "createdAt"
      FROM user_notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100\`, [req.user.id]);
    const unreadCount = rows.reduce((count, row) => count + (row.readAt ? 0 : 1), 0);
    res.json({ notifications: rows, unreadCount });
  } catch (e) { next(e); }
});

app.patch('/api/notifications/:id/read', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(\`UPDATE user_notifications SET read_at=COALESCE(read_at,NOW())
      WHERE id=$1 AND user_id=$2 RETURNING id,read_at AS "readAt"\`, [req.params.id, req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Notificación no encontrada' });
    res.json(rows[0]);
  } catch (e) { next(e); }
});

app.patch('/api/notifications/read-all', auth, async (req, res, next) => {
  try {
    const result = await pool.query('UPDATE user_notifications SET read_at=NOW() WHERE user_id=$1 AND read_at IS NULL', [req.user.id]);
    res.json({ updated: result.rowCount });
  } catch (e) { next(e); }
});

app.get('/api/admin/notifications/recipients', auth, allow('admin'), async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 100);
    const params = [];
    let where = "WHERE role <> 'admin'";
    if (q) { params.push('%' + q + '%'); where += \` AND (name ILIKE $1 OR email ILIKE $1)\`; }
    const { rows } = await pool.query(\`SELECT id,name,email,account_status AS "accountStatus" FROM users \${where} ORDER BY name ASC LIMIT 30\`, params);
    res.json(rows);
  } catch (e) { next(e); }
});

app.get('/api/admin/notifications/history', auth, allow('admin'), async (_req, res, next) => {
  try {
    const { rows } = await pool.query(\`SELECT c.id,c.audience,c.title,c.body,c.recipient_count AS "recipientCount",c.created_at AS "createdAt",
      u.name AS "targetName",u.email AS "targetEmail"
      FROM admin_notification_campaigns c LEFT JOIN users u ON u.id=c.target_user_id
      ORDER BY c.created_at DESC LIMIT 50\`);
    res.json(rows);
  } catch (e) { next(e); }
});

app.post('/api/admin/notifications/send', auth, allow('admin'), async (req, res, next) => {
  try {
    const audience = String(req.body.audience || 'user');
    const title = String(req.body.title || '').trim().slice(0, 120);
    const body = String(req.body.body || '').trim().slice(0, 2000);
    const targetUserId = Number(req.body.userId);
    if (!['user','all'].includes(audience)) return res.status(400).json({ error: 'Destino inválido' });
    if (title.length < 2) return res.status(400).json({ error: 'Escribe un título para la notificación' });
    if (body.length < 2) return res.status(400).json({ error: 'Escribe el mensaje de la notificación' });
    if (audience === 'user' && (!Number.isInteger(targetUserId) || targetUserId < 1)) return res.status(400).json({ error: 'Selecciona un usuario' });

    const result = await withTransaction(async (client) => {
      let recipientCount = 0;
      if (audience === 'user') {
        const exists = await client.query("SELECT 1 FROM users WHERE id=$1 AND role <> 'admin' AND account_status <> 'suspended' LIMIT 1", [targetUserId]);
        if (!exists.rows[0]) { const err = new Error('Usuario no encontrado o no disponible'); err.statusCode = 404; throw err; }
        recipientCount = 1;
      } else {
        const countResult = await client.query("SELECT COUNT(*)::int AS count FROM users WHERE role <> 'admin' AND account_status <> 'suspended'");
        recipientCount = Number(countResult.rows[0]?.count || 0);
      }

      const { rows: campaignRows } = await client.query(\`INSERT INTO admin_notification_campaigns(admin_id,audience,target_user_id,title,body,recipient_count)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING id,created_at AS "createdAt"\`,
        [req.user.id, audience, audience === 'user' ? targetUserId : null, title, body, recipientCount]);
      const campaign = campaignRows[0];

      if (audience === 'user') {
        await client.query(\`INSERT INTO user_notifications(user_id,campaign_id,title,body)
          SELECT id,$2,$3,$4 FROM users WHERE id=$1 AND role <> 'admin' AND account_status <> 'suspended'\`,
          [targetUserId, campaign.id, title, body]);
      } else {
        await client.query(\`INSERT INTO user_notifications(user_id,campaign_id,title,body)
          SELECT id,$1,$2,$3 FROM users WHERE role <> 'admin' AND account_status <> 'suspended'\`,
          [campaign.id, title, body]);
      }

      return { campaignId: campaign.id, recipientCount, createdAt: campaign.createdAt };
    });

    const reason = audience === 'all'
      ? \`Notificación general enviada a \${result.recipientCount} usuarios: \${title}\`
      : \`Notificación individual enviada al usuario \${targetUserId}: \${title}\`;
    pool.query(\`INSERT INTO admin_actions(admin_id,action,target_type,target_id,reason)
      VALUES($1,'notification_sent',$2,$3,$4)\`,
      [req.user.id, audience === 'all' ? 'users' : 'user', audience === 'all' ? 0 : targetUserId, reason])
      .catch((auditError) => console.error('Notification audit write failed:', auditError.message));

    res.status(201).json({ ...result, message: result.recipientCount === 1 ? 'Notificación enviada.' : \`Notificación enviada a \${result.recipientCount} usuarios.\` });
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
    console.error('Notification send failed:', e.message);
    res.status(500).json({ error: 'No se pudo enviar la notificación. Intenta nuevamente.' });
  }
});

`;

replaceOrThrow(
  "app.get('/api/admin/activity', auth, allow('admin'), async (_req, res, next) => {",
  routes + "app.get('/api/admin/activity', auth, allow('admin'), async (_req, res, next) => {",
  'notification routes'
);

fs.writeFileSync(serverPath, source, 'utf8');
console.log('Admin notification center applied');
