const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');
let source = fs.readFileSync(serverPath, 'utf8');

function replaceOnce(needle, replacement, label) {
  if (source.includes(replacement)) return;
  if (!source.includes(needle)) throw new Error(`Block 6 requests patch failed: ${label}`);
  source = source.replace(needle, replacement);
}

replaceOnce(
  `    CREATE TABLE IF NOT EXISTS email_verification_codes (`,
  `    CREATE TABLE IF NOT EXISTS service_requests (\n      id BIGSERIAL PRIMARY KEY,\n      service_id BIGINT NOT NULL REFERENCES services(id) ON DELETE CASCADE,\n      client_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,\n      provider_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,\n      details TEXT NOT NULL CHECK (char_length(details) BETWEEN 10 AND 1200),\n      budget_min NUMERIC(10,2),\n      budget_max NUMERIC(10,2),\n      desired_time TEXT NOT NULL DEFAULT '',\n      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','quoted','accepted','declined','cancelled')),\n      quote_amount NUMERIC(10,2),\n      provider_message TEXT NOT NULL DEFAULT '',\n      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),\n      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()\n    );\n    CREATE INDEX IF NOT EXISTS idx_service_requests_client_created ON service_requests(client_id, created_at DESC);\n    CREATE INDEX IF NOT EXISTS idx_service_requests_provider_created ON service_requests(provider_id, created_at DESC);\n    CREATE TABLE IF NOT EXISTS email_verification_codes (`,
  'service requests table'
);

const routes = `
app.get('/api/service-requests', auth, allow('user'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(\`SELECT r.id,r.service_id AS "serviceId",r.client_id AS "clientId",r.provider_id AS "providerId",
      r.details,r.budget_min::float AS "budgetMin",r.budget_max::float AS "budgetMax",r.desired_time AS "desiredTime",
      r.status,r.quote_amount::float AS "quoteAmount",r.provider_message AS "providerMessage",r.created_at AS "createdAt",r.updated_at AS "updatedAt",
      s.name AS "serviceName",client.name AS "clientName",provider.name AS "providerName",
      CASE WHEN r.client_id=$1 THEN 'client' ELSE 'provider' END AS perspective
      FROM service_requests r JOIN services s ON s.id=r.service_id
      JOIN users client ON client.id=r.client_id JOIN users provider ON provider.id=r.provider_id
      WHERE r.client_id=$1 OR r.provider_id=$1 ORDER BY r.updated_at DESC LIMIT 200\`, [req.user.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

app.post('/api/service-requests', auth, allow('user'), async (req, res, next) => {
  try {
    const serviceId = Number(req.body.serviceId);
    const details = String(req.body.details || '').trim().slice(0, 1200);
    const budgetMinRaw = req.body.budgetMin;
    const budgetMaxRaw = req.body.budgetMax;
    const budgetMin = budgetMinRaw === '' || budgetMinRaw == null ? null : Number(budgetMinRaw);
    const budgetMax = budgetMaxRaw === '' || budgetMaxRaw == null ? null : Number(budgetMaxRaw);
    const desiredTime = String(req.body.desiredTime || '').trim().slice(0, 160);
    if (!Number.isInteger(serviceId) || serviceId < 1 || details.length < 10) return res.status(400).json({ error: 'Describe lo que necesitas con al menos 10 caracteres' });
    if ((budgetMin != null && (!Number.isFinite(budgetMin) || budgetMin < 0)) || (budgetMax != null && (!Number.isFinite(budgetMax) || budgetMax < 0)) || (budgetMin != null && budgetMax != null && budgetMin > budgetMax)) return res.status(400).json({ error: 'Rango de presupuesto inválido' });
    const { rows: services } = await pool.query(\`SELECT s.id,s.name,s.provider_id,s.service_type FROM services s
      JOIN users u ON u.id=s.provider_id WHERE s.id=$1 AND s.active=TRUE AND COALESCE(s.paused,FALSE)=FALSE AND u.account_status='active'\`, [serviceId]);
    const service = services[0];
    if (!service) return res.status(404).json({ error: 'Servicio no encontrado' });
    if (String(service.provider_id) === String(req.user.id)) return res.status(400).json({ error: 'No puedes solicitar presupuesto para tu propio servicio' });
    if (isYouthAccount(req.user) && service.service_type === 'Presencial') return res.status(403).json({ error: 'Durante la beta, las cuentas juveniles solo pueden solicitar servicios remotos', code: 'YOUTH_REMOTE_ONLY' });
    const { rows } = await withTransaction(async (client) => {
      const result = await client.query(\`INSERT INTO service_requests(service_id,client_id,provider_id,details,budget_min,budget_max,desired_time)
        VALUES($1,$2,$3,$4,$5,$6,$7)
        RETURNING id,service_id AS "serviceId",details,budget_min::float AS "budgetMin",budget_max::float AS "budgetMax",desired_time AS "desiredTime",status,created_at AS "createdAt"\`,
        [serviceId, req.user.id, service.provider_id, details, budgetMin, budgetMax, desiredTime]);
      const message = \`Nueva solicitud de presupuesto para \${service.name}: \${details.slice(0, 700)}\`;
      await client.query(\`INSERT INTO messages(service_id,sender_id,recipient_id,body) VALUES($1,$2,$3,$4)\`, [serviceId, req.user.id, service.provider_id, message]);
      return result.rows;
    });
    res.status(201).json({ ...rows[0], providerId: service.provider_id });
  } catch (e) { next(e); }
});

app.patch('/api/service-requests/:id/quote', auth, allow('user'), async (req, res, next) => {
  try {
    const amount = Number(req.body.amount);
    const message = String(req.body.message || '').trim().slice(0, 800);
    if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'Precio de propuesta inválido' });
    const { rows } = await pool.query(\`UPDATE service_requests SET status='quoted',quote_amount=$1,provider_message=$2,updated_at=NOW()
      WHERE id=$3 AND provider_id=$4 AND status='pending'
      RETURNING id,service_id AS "serviceId",client_id AS "clientId",quote_amount::float AS "quoteAmount",provider_message AS "providerMessage",status\`,
      [amount, message, req.params.id, req.user.id]);
    if (!rows[0]) return res.status(409).json({ error: 'Esta solicitud ya no puede recibir una propuesta' });
    const body = message ? \`Propuesta: $\${amount.toFixed(2)} — \${message}\` : \`Propuesta: $\${amount.toFixed(2)}\`;
    await pool.query(\`INSERT INTO messages(service_id,sender_id,recipient_id,body) VALUES($1,$2,$3,$4)\`, [rows[0].serviceId, req.user.id, rows[0].clientId, body]);
    res.json(rows[0]);
  } catch (e) { next(e); }
});

app.patch('/api/service-requests/:id/status', auth, allow('user'), async (req, res, next) => {
  try {
    const status = String(req.body.status || '');
    const { rows: currentRows } = await pool.query('SELECT id,service_id,client_id,provider_id,status FROM service_requests WHERE id=$1', [req.params.id]);
    const current = currentRows[0];
    if (!current) return res.status(404).json({ error: 'Solicitud no encontrada' });
    const isClient = String(current.client_id) === String(req.user.id);
    const isProvider = String(current.provider_id) === String(req.user.id);
    if (!isClient && !isProvider) return res.status(403).json({ error: 'No tienes acceso a esta solicitud' });
    const allowed = isClient
      ? { pending:['cancelled'], quoted:['accepted','cancelled'], accepted:[], declined:[], cancelled:[] }
      : { pending:['declined'], quoted:[], accepted:[], declined:[], cancelled:[] };
    if (!allowed[current.status]?.includes(status)) return res.status(409).json({ error: 'Cambio de estado no permitido' });
    const { rows } = await pool.query('UPDATE service_requests SET status=$1,updated_at=NOW() WHERE id=$2 RETURNING id,status,service_id AS "serviceId"', [status, current.id]);
    if (status === 'accepted') {
      await pool.query(\`INSERT INTO messages(service_id,sender_id,recipient_id,body) VALUES($1,$2,$3,$4)\`, [current.service_id, req.user.id, current.provider_id, 'Acepté tu propuesta. Podemos coordinar los detalles y la reserva dentro de Zeqviro.']);
    }
    res.json(rows[0]);
  } catch (e) { next(e); }
});

`;

replaceOnce(
  `app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));`,
  routes + `app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));`,
  'service request routes'
);

fs.writeFileSync(serverPath, source, 'utf8');
console.log('Block 6 request and quote workflow applied');
