const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');
let source = fs.readFileSync(serverPath, 'utf8');

function replaceOnce(needle, replacement, label) {
  if (source.includes(replacement)) return;
  if (!source.includes(needle)) throw new Error(`Block 6 provider profiles patch failed: ${label}`);
  source = source.replace(needle, replacement);
}

const providerSelect = `    const { rows: users } = await pool.query(\`SELECT id,name,headline,bio,skills,languages,location,remote_available AS \"remoteAvailable\",avatar_url AS \"avatarUrl\",experience,portfolio_url AS \"portfolioUrl\",age_band AS \"ageBand\",`;
const providerSelectNew = `    const { rows: users } = await pool.query(\`SELECT id,name,headline,bio,skills,languages,location,remote_available AS \"remoteAvailable\",avatar_url AS \"avatarUrl\",experience,portfolio_url AS \"portfolioUrl\",age_band AS \"ageBand\",email_verified AS \"emailVerified\",identity_status AS \"identityStatus\",created_at AS \"memberSince\",\n      (SELECT COUNT(*)::int FROM bookings b JOIN services s2 ON s2.id=b.service_id WHERE s2.provider_id=users.id AND b.status='completed') AS \"completedJobs\",`;
replaceOnce(providerSelect, providerSelectNew, 'provider public trust signals');

const serviceSelect = `    const { rows: services } = await pool.query('SELECT id,name,description AS desc,price::float,area FROM services WHERE provider_id=$1 AND active=TRUE AND COALESCE(paused,FALSE)=FALSE ORDER BY created_at DESC', [req.params.id]);`;
const serviceSelectNew = `    const { rows: services } = await pool.query(\`SELECT id,name,description AS desc,category AS cat,service_type AS type,price::float,hourly_price::float AS hourly,area,\n      EXISTS (SELECT 1 FROM availability a WHERE a.service_id=services.id AND a.available=TRUE AND a.starts_at>NOW()) AS \"hasAvailability\"\n      FROM services WHERE provider_id=$1 AND active=TRUE AND COALESCE(paused,FALSE)=FALSE ORDER BY created_at DESC\`, [req.params.id]);`;
replaceOnce(serviceSelect, serviceSelectNew, 'provider service cards');

fs.writeFileSync(serverPath, source, 'utf8');
console.log('Block 6 provider profiles patch applied');
