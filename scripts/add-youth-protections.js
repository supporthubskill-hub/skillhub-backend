const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');
let source = fs.readFileSync(serverPath, 'utf8');

function replaceOnce(needle, replacement, label) {
  if (source.includes(replacement)) return;
  if (!source.includes(needle)) throw new Error(`Youth protections patch failed: ${label}`);
  source = source.replace(needle, replacement);
}

const allowHelper = "const allow = (...roles) => (req, res, next) => roles.includes(req.user.role)\n  ? next() : res.status(403).json({ error: 'Insufficient permissions' });";
const youthHelpers = `${allowHelper}\n\nconst isYouthAccount = (user) => ['14_15','16_17'].includes(user?.ageBand || user?.age_band || '');\nconst YOUTH_REMOTE_ONLY_MESSAGE = 'Durante la beta, las cuentas menores de 18 años solo pueden ofrecer y reservar servicios remotos.';`;
replaceOnce(allowHelper, youthHelpers, 'youth helpers');

const servicesPublicSelect = `      s.price::float,s.hourly_price::float AS hourly,s.area,u.name AS \"providerName\",u.id AS \"providerId\",`;
const servicesPublicSelectNew = `      s.price::float,s.hourly_price::float AS hourly,CASE WHEN u.age_band IN ('14_15','16_17') THEN 'Remoto' ELSE s.area END AS area,u.name AS \"providerName\",u.id AS \"providerId\",`;
replaceOnce(servicesPublicSelect, servicesPublicSelectNew, 'public service youth area privacy');

const createValidation = `    if (!validServiceInput(v)) return res.status(400).json({ error: 'Revisa los datos del servicio' });`;
const createValidationNew = `${createValidation}\n    if (isYouthAccount(req.user) && v.type === 'Presencial') return res.status(403).json({ error: YOUTH_REMOTE_ONLY_MESSAGE, code: 'YOUTH_REMOTE_ONLY' });`;
replaceOnce(createValidation, createValidationNew, 'service create restriction');

const patchRoute = `app.patch('/api/services/:id', auth, allow('user'), async (req, res, next) => {\n  try {\n    const v = readServiceInput(req);\n    if (!validServiceInput(v)) return res.status(400).json({ error: 'Revisa los datos del servicio' });`;
const patchRouteNew = `${patchRoute}\n    if (isYouthAccount(req.user) && v.type === 'Presencial') return res.status(403).json({ error: YOUTH_REMOTE_ONLY_MESSAGE, code: 'YOUTH_REMOTE_ONLY' });`;
replaceOnce(patchRoute, patchRouteNew, 'service edit restriction');

const bookingServiceSelect = `    const { rows: services } = await client.query(\`SELECT s.id,s.name,s.price,s.provider_id FROM services s\n      JOIN users u ON u.id=s.provider_id WHERE s.id=$1 AND s.active=TRUE AND COALESCE(s.paused,FALSE)=FALSE AND u.account_status='active'\`, [req.body.serviceId]);`;
const bookingServiceSelectNew = `    const { rows: services } = await client.query(\`SELECT s.id,s.name,s.price,s.provider_id,s.service_type,u.age_band AS provider_age_band FROM services s\n      JOIN users u ON u.id=s.provider_id WHERE s.id=$1 AND s.active=TRUE AND COALESCE(s.paused,FALSE)=FALSE AND u.account_status='active'\`, [req.body.serviceId]);`;
replaceOnce(bookingServiceSelect, bookingServiceSelectNew, 'booking youth fields');

const ownBookingCheck = `    if (String(services[0].provider_id) === String(req.user.id)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'No puedes reservar tu propio servicio' }); }`;
const ownBookingCheckNew = `${ownBookingCheck}\n    const youthInBooking = isYouthAccount(req.user) || ['14_15','16_17'].includes(services[0].provider_age_band || '');\n    if (youthInBooking && services[0].service_type === 'Presencial') { await client.query('ROLLBACK'); return res.status(403).json({ error: YOUTH_REMOTE_ONLY_MESSAGE, code: 'YOUTH_REMOTE_ONLY' }); }`;
replaceOnce(ownBookingCheck, ownBookingCheckNew, 'booking in-person restriction');

const providerSelect = `    const { rows: users } = await pool.query(\`SELECT id,name,headline,bio,skills,languages,location,remote_available AS \"remoteAvailable\",avatar_url AS \"avatarUrl\",experience,portfolio_url AS \"portfolioUrl\",`;
const providerSelectNew = `    const { rows: users } = await pool.query(\`SELECT id,name,headline,bio,skills,languages,location,remote_available AS \"remoteAvailable\",avatar_url AS \"avatarUrl\",experience,portfolio_url AS \"portfolioUrl\",age_band AS \"ageBand\",`;
replaceOnce(providerSelect, providerSelectNew, 'provider age band internal select');

const providerResponse = `    res.json({ profile: users[0], services, reviews });`;
const providerResponseNew = `    const profile = { ...users[0] };\n    if (['14_15','16_17'].includes(profile.ageBand || '')) {\n      profile.location = '';\n      profile.portfolioUrl = '';\n      profile.youthPrivacy = true;\n    }\n    delete profile.ageBand;\n    res.json({ profile, services: services.map((service) => ({ ...service, area: profile.youthPrivacy ? 'Remoto' : service.area })), reviews });`;
replaceOnce(providerResponse, providerResponseNew, 'provider public privacy');

const securitySelect = `    const { rows } = await pool.query(\`SELECT email_verified AS \"emailVerified\",phone_verified AS \"phoneVerified\",\n      identity_status AS \"identityStatus\" FROM users WHERE id=$1\`, [req.user.id]);\n    res.json(rows[0]);`;
const securitySelectNew = `    const { rows } = await pool.query(\`SELECT email_verified AS \"emailVerified\",phone_verified AS \"phoneVerified\",\n      identity_status AS \"identityStatus\",age_band AS \"ageBand\" FROM users WHERE id=$1\`, [req.user.id]);\n    const security = rows[0] || {};\n    const youth = ['14_15','16_17'].includes(security.ageBand || '');\n    res.json({ ...security, juvenileProtections: youth ? { enabled: true, remoteOnlyDuringBeta: true, publicLocationHidden: true, publicPortfolioHidden: true } : { enabled: false } });`;
replaceOnce(securitySelect, securitySelectNew, 'security center youth status');

fs.writeFileSync(serverPath, source, 'utf8');
console.log('Youth protections backend patch applied');
