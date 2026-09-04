const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');
let source = fs.readFileSync(serverPath, 'utf8');

function replaceOrThrow(needle, replacement, label) {
  if (!source.includes(needle)) throw new Error(`Provider service controls patch failed: ${label}`);
  source = source.replace(needle, replacement);
}

replaceOrThrow(
  'FROM services s WHERE s.provider_id=$1 ORDER BY s.created_at DESC`, [req.user.id]),',
  'FROM services s WHERE s.provider_id=$1 AND s.active=TRUE ORDER BY s.created_at DESC`, [req.user.id]),',
  'only show active services to provider'
);

const routes = `app.delete('/api/services/:id', auth, allow('user'), async (req, res, next) => {
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
    res.json({
      id: result.id,
      message: 'Servicio eliminado del marketplace.',
      quotaNote: 'Eliminar un servicio no recupera el intento usado durante las últimas 24 horas.'
    });
  } catch (e) { next(e); }
});

`;

replaceOrThrow(
  'function readServiceInput(req) {',
  routes + 'function readServiceInput(req) {',
  'provider delete service route'
);

fs.writeFileSync(serverPath, source, 'utf8');
console.log('Provider service controls applied');
