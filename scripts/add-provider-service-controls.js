const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');
let source = fs.readFileSync(serverPath, 'utf8');

function replaceOrThrow(needle, replacement, label) {
  if (!source.includes(needle)) throw new Error(`Provider service controls patch failed: ${label}`);
  source = source.replace(needle, replacement);
}

replaceOrThrow(
  'CREATE TABLE IF NOT EXISTS availability (',
  `ALTER TABLE services ADD COLUMN IF NOT EXISTS paused BOOLEAN NOT NULL DEFAULT FALSE;\n\n    CREATE TABLE IF NOT EXISTS availability (`,
  'service paused column'
);

replaceOrThrow(
  `      WHERE s.active=TRUE AND u.account_status='active'\n      ORDER BY s.created_at DESC`,
  `      WHERE s.active=TRUE AND COALESCE(s.paused,FALSE)=FALSE AND u.account_status='active'\n      ORDER BY s.created_at DESC`,
  'hide paused services from marketplace'
);

replaceOrThrow(
  `        s.price::float,s.hourly_price::float AS hourly,s.area,s.active,s.created_at AS "createdAt",`,
  `        s.price::float,s.hourly_price::float AS hourly,s.area,s.active,s.paused,s.created_at AS "createdAt",`,
  'return paused state to provider'
);

replaceOrThrow(
  'FROM services s WHERE s.provider_id=$1 ORDER BY s.created_at DESC`, [req.user.id]),',
  'FROM services s WHERE s.provider_id=$1 AND s.active=TRUE ORDER BY s.created_at DESC`, [req.user.id]),',
  'only show non-deleted services to provider'
);

replaceOrThrow(
  `JOIN users u ON u.id=s.provider_id WHERE s.id=$1 AND s.active=TRUE AND u.account_status='active'\`, [req.body.serviceId]);`,
  `JOIN users u ON u.id=s.provider_id WHERE s.id=$1 AND s.active=TRUE AND COALESCE(s.paused,FALSE)=FALSE AND u.account_status='active'\`, [req.body.serviceId]);`,
  'prevent booking paused services'
);

replaceOrThrow(
  `    const { rows } = await pool.query(\`SELECT id,starts_at AS "startsAt",duration_minutes AS "durationMinutes"\n      FROM availability WHERE service_id=$1 AND available=TRUE AND starts_at>NOW() ORDER BY starts_at LIMIT 100\`, [req.params.id]);`,
  `    const { rows } = await pool.query(\`SELECT a.id,a.starts_at AS "startsAt",a.duration_minutes AS "durationMinutes"\n      FROM availability a JOIN services s ON s.id=a.service_id\n      WHERE a.service_id=$1 AND a.available=TRUE AND a.starts_at>NOW() AND s.active=TRUE AND COALESCE(s.paused,FALSE)=FALSE\n      ORDER BY a.starts_at LIMIT 100\`, [req.params.id]);`,
  'hide availability for paused services'
);

const routes = `app.patch('/api/services/:id/pause', auth, allow('user'), async (req, res, next) => {
  try {
    const serviceId = Number(req.params.id);
    if (!Number.isInteger(serviceId) || serviceId < 1) return res.status(400).json({ error: 'Servicio inválido' });
    if (typeof req.body?.paused !== 'boolean') return res.status(400).json({ error: 'Indica si quieres pausar o reactivar el servicio' });
    const { rows } = await pool.query(
      'UPDATE services SET paused=$1 WHERE id=$2 AND provider_id=$3 AND active=TRUE RETURNING id,name,paused',
      [req.body.paused, serviceId, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Servicio no encontrado' });
    res.json({
      id: rows[0].id,
      name: rows[0].name,
      paused: rows[0].paused,
      message: rows[0].paused ? 'Servicio pausado. Ya no aparece en el marketplace.' : 'Servicio reactivado.'
    });
  } catch (e) { next(e); }
});

app.delete('/api/services/:id', auth, allow('user'), async (req, res, next) => {
  try {
    const serviceId = Number(req.params.id);
    if (!Number.isInteger(serviceId) || serviceId < 1) return res.status(400).json({ error: 'Servicio inválido' });
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        'UPDATE services SET active=FALSE WHERE id=$1 AND provider_id=$2 AND active=TRUE RETURNING id,name,created_at AS "createdAt"',
        [serviceId, req.user.id]
      );
      const service = rows[0];
      if (!service) return null;
      await client.query('UPDATE availability SET available=FALSE WHERE service_id=$1 AND provider_id=$2 AND starts_at>NOW()', [serviceId, req.user.id]);
      return service;
    });
    if (!result) return res.status(404).json({ error: 'Servicio no encontrado o ya eliminado' });
    res.json({ id: result.id, message: 'Servicio eliminado del marketplace.', quotaNote: 'Eliminar un servicio no recupera el intento usado durante las últimas 24 horas.' });
  } catch (e) { next(e); }
});

`;

replaceOrThrow('function readServiceInput(req) {', routes + 'function readServiceInput(req) {', 'provider service routes');

fs.writeFileSync(serverPath, source, 'utf8');
console.log('Provider service controls applied');
