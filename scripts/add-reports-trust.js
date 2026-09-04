const fs = require('fs');
const path = require('path');
const serverPath = path.join(__dirname, '..', 'server.js');
let source = fs.readFileSync(serverPath, 'utf8');

function insertBefore(needle, addition, label) {
  if (source.includes(addition.trim())) return;
  if (!source.includes(needle)) throw new Error(`Reports/trust patch failed: ${label}`);
  source = source.replace(needle, addition + needle);
}

// Make suspension explicit at login instead of looking like a bad password.
const oldLogin = "    if (!user || user.account_status === 'suspended' || !(await bcrypt.compare(String(req.body.password || ''), user.password_hash))) {\n      return res.status(401).json({ error: 'Invalid credentials' });\n    }";
const newLogin = "    if (!user || !(await bcrypt.compare(String(req.body.password || ''), user.password_hash))) {\n      return res.status(401).json({ error: 'Invalid credentials' });\n    }\n    if (user.account_status === 'suspended') {\n      return res.status(403).json({\n        error: 'Account suspended',\n        code: 'ACCOUNT_SUSPENDED',\n        suspendedUntil: user.suspended_until || null,\n        reason: user.suspension_reason || ''\n      });\n    }";
if (source.includes(oldLogin)) source = source.replace(oldLogin, newLogin);

const routes = `// ZEQVIRO_REPORTS_TRUST_ROUTES
app.post('/api/reports', auth, async (req, res, next) => {
  try {
    const targetUserId = req.body.targetUserId ? Number(req.body.targetUserId) : null;
    const serviceId = req.body.serviceId ? Number(req.body.serviceId) : null;
    const reason = String(req.body.reason || '').trim();
    const details = String(req.body.details || '').trim();
    if ((!targetUserId && !serviceId) || !reason || details.length < 8 || details.length > 1500) {
      return res.status(400).json({ error: 'Selecciona qué reportar, un motivo y explica el problema.' });
    }
    if (targetUserId === Number(req.user.id)) return res.status(400).json({ error: 'No puedes reportarte a ti mismo.' });
    if (serviceId) {
      const { rows } = await pool.query('SELECT id,provider_id FROM services WHERE id=$1', [serviceId]);
      if (!rows[0]) return res.status(404).json({ error: 'Servicio no encontrado.' });
      if (Number(rows[0].provider_id) === Number(req.user.id)) return res.status(400).json({ error: 'No puedes reportar tu propio servicio.' });
    }
    if (targetUserId) {
      const { rows } = await pool.query('SELECT id FROM users WHERE id=$1', [targetUserId]);
      if (!rows[0]) return res.status(404).json({ error: 'Usuario no encontrado.' });
    }
    const duplicate = await pool.query(\`SELECT id FROM reports WHERE reporter_id=$1 AND status IN ('open','reviewing') AND (($2::bigint IS NOT NULL AND target_user_id=$2) OR ($3::bigint IS NOT NULL AND service_id=$3)) LIMIT 1\`, [req.user.id, targetUserId, serviceId]);
    if (duplicate.rows[0]) return res.status(409).json({ error: 'Ya tienes un reporte activo sobre este caso.' });
    const { rows } = await pool.query(\`INSERT INTO reports(reporter_id,target_user_id,service_id,reason,details) VALUES($1,$2,$3,$4,$5) RETURNING id,status,created_at AS "createdAt"\`, [req.user.id, targetUserId, serviceId, reason.slice(0,120), details]);
    res.status(201).json({ report: rows[0], message: 'Reporte enviado a moderación.' });
  } catch (e) { next(e); }
});

app.get('/api/reports/me', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(\`SELECT r.id,r.reason,r.details,r.status,r.created_at AS "createdAt",r.target_user_id AS "targetUserId",u.name AS "targetUserName",r.service_id AS "serviceId",s.name AS "serviceName" FROM reports r LEFT JOIN users u ON u.id=r.target_user_id LEFT JOIN services s ON s.id=r.service_id WHERE r.reporter_id=$1 ORDER BY r.created_at DESC LIMIT 100\`, [req.user.id]);
    res.json({ reports: rows });
  } catch (e) { next(e); }
});

app.get('/api/admin/reports', auth, allow('admin'), async (req, res, next) => {
  try {
    const status = String(req.query.status || '').trim();
    const allowed = ['open','reviewing','resolved','dismissed'];
    const params = [];
    let where = '';
    if (status && allowed.includes(status)) { params.push(status); where = 'WHERE r.status=$1'; }
    const { rows } = await pool.query(\`SELECT r.id,r.reason,r.details,r.status,r.created_at AS "createdAt",r.reporter_id AS "reporterId",reporter.name AS "reporterName",r.target_user_id AS "targetUserId",target.name AS "targetUserName",r.service_id AS "serviceId",s.name AS "serviceName" FROM reports r JOIN users reporter ON reporter.id=r.reporter_id LEFT JOIN users target ON target.id=r.target_user_id LEFT JOIN services s ON s.id=r.service_id \${where} ORDER BY CASE r.status WHEN 'open' THEN 0 WHEN 'reviewing' THEN 1 ELSE 2 END,r.created_at DESC LIMIT 250\`, params);
    res.json({ reports: rows });
  } catch (e) { next(e); }
});

app.patch('/api/admin/reports/:id/status', auth, allow('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const status = String(req.body.status || '').trim();
    const note = String(req.body.note || '').trim();
    if (!Number.isInteger(id) || !['open','reviewing','resolved','dismissed'].includes(status)) return res.status(400).json({ error: 'Estado de reporte inválido.' });
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query('UPDATE reports SET status=$1 WHERE id=$2 RETURNING id,reporter_id,status,reason', [status,id]);
      const report = rows[0];
      if (!report) return null;
      await client.query(\`INSERT INTO admin_actions(admin_id,action,target_type,target_id,reason) VALUES($1,'report_status_changed','report',$2,$3)\`, [req.user.id,id,\`Estado: \${status}. \${note}\`.trim()]);
      try {
        await client.query(\`INSERT INTO user_notifications(user_id,title,message,type) VALUES($1,$2,$3,'moderation')\`, [report.reporter_id,'Actualización de tu reporte', status === 'reviewing' ? 'Tu reporte está siendo revisado por el equipo de Zeqviro.' : status === 'resolved' ? 'Tu reporte fue revisado y marcado como resuelto.' : status === 'dismissed' ? 'Tu reporte fue revisado y cerrado sin acción adicional.' : 'Tu reporte volvió al estado pendiente.']);
      } catch (_) {}
      return report;
    });
    if (!result) return res.status(404).json({ error: 'Reporte no encontrado.' });
    res.json({ report: result });
  } catch (e) { next(e); }
});

`;
insertBefore("app.get('/api/admin/activity', auth, allow('admin'), async (_req, res, next) => {", routes, 'admin activity anchor');
fs.writeFileSync(serverPath, source, 'utf8');
console.log('Reports and trust patch applied');
