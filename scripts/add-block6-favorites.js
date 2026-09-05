const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');
let source = fs.readFileSync(serverPath, 'utf8');

function replaceOnce(needle, replacement, label) {
  if (source.includes(replacement)) return;
  if (!source.includes(needle)) throw new Error(`Block 6 favorites patch failed: ${label}`);
  source = source.replace(needle, replacement);
}

replaceOnce(
  `    CREATE TABLE IF NOT EXISTS email_verification_codes (`,
  `    CREATE TABLE IF NOT EXISTS favorites (\n      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,\n      service_id BIGINT NOT NULL REFERENCES services(id) ON DELETE CASCADE,\n      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),\n      PRIMARY KEY(user_id, service_id)\n    );\n    CREATE INDEX IF NOT EXISTS idx_favorites_user_created ON favorites(user_id, created_at DESC);\n    CREATE TABLE IF NOT EXISTS email_verification_codes (`,
  'favorites table'
);

const routes = `
app.get('/api/favorites', auth, allow('user'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(\`SELECT service_id AS "serviceId",created_at AS "createdAt"
      FROM favorites WHERE user_id=$1 ORDER BY created_at DESC\`, [req.user.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

app.post('/api/favorites/:serviceId', auth, allow('user'), async (req, res, next) => {
  try {
    const serviceId = Number(req.params.serviceId);
    if (!Number.isInteger(serviceId) || serviceId < 1) return res.status(400).json({ error: 'Servicio inválido' });
    const { rows: services } = await pool.query(\`SELECT s.id,s.provider_id FROM services s
      JOIN users u ON u.id=s.provider_id
      WHERE s.id=$1 AND s.active=TRUE AND COALESCE(s.paused,FALSE)=FALSE AND u.account_status='active'\`, [serviceId]);
    if (!services[0]) return res.status(404).json({ error: 'Servicio no encontrado' });
    if (String(services[0].provider_id) === String(req.user.id)) return res.status(400).json({ error: 'No necesitas guardar tu propio servicio' });
    await pool.query(\`INSERT INTO favorites(user_id,service_id) VALUES($1,$2)
      ON CONFLICT(user_id,service_id) DO NOTHING\`, [req.user.id, serviceId]);
    res.status(201).json({ serviceId, favorite: true });
  } catch (e) { next(e); }
});

app.delete('/api/favorites/:serviceId', auth, allow('user'), async (req, res, next) => {
  try {
    const serviceId = Number(req.params.serviceId);
    if (!Number.isInteger(serviceId) || serviceId < 1) return res.status(400).json({ error: 'Servicio inválido' });
    await pool.query('DELETE FROM favorites WHERE user_id=$1 AND service_id=$2', [req.user.id, serviceId]);
    res.status(204).end();
  } catch (e) { next(e); }
});

`;
replaceOnce(
  `app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));`,
  routes + `app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));`,
  'favorites routes'
);

fs.writeFileSync(serverPath, source, 'utf8');
console.log('Block 6 favorites patch applied');
