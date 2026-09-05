const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const required = [
  ['service image column', 'ADD COLUMN IF NOT EXISTS image_url TEXT NOT NULL DEFAULT'],
  ['public image field', 's.image_url AS "imageUrl"'],
  ['service input image', "imageUrl: String(req.body.imageUrl || '')"],
  ['https image validation', '!v.imageUrl || /^https:\\/\\//i.test(v.imageUrl)'],
  ['service create image persistence', 'area,image_url)'],
  ['service update image persistence', 'area=$7,image_url=$8'],
  ['provider service enhanced details', 'hourly_price::float AS hourly,area,image_url AS "imageUrl"'],
  ['provider trust signals', 'completedJobs'],
  ['provider member since', 'memberSince'],
  ['favorites table', 'CREATE TABLE IF NOT EXISTS favorites'],
  ['favorites list route', "app.get('/api/favorites'"],
  ['favorites save route', "app.post('/api/favorites/:serviceId'"],
  ['service requests table', 'CREATE TABLE IF NOT EXISTS service_requests'],
  ['service requests route', "app.get('/api/service-requests'"],
  ['quote route', "app.patch('/api/service-requests/:id/quote'"],
  ['booking reschedule route', "app.post('/api/bookings/:id/reschedule'"],
  ['verified review eligibility route', "app.get('/api/reviews/me'"],
  ['provider dashboard route', "app.get('/api/provider-dashboard'"],
  ['notification kind metadata', "ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'general'"],
  ['notification action metadata', 'action_type AS "actionType"'],
  ['marketplace notification write', "'Nueva solicitud de presupuesto'"],
  ['payments remain disabled', 'enabled: false']
];

for (const [label, needle] of required) {
  if (!source.includes(needle)) throw new Error(`Block 6 verification failed: ${label}`);
}

const forbidden = [
  ['public birth date exposure', 'birth_date AS "birthDate"'],
  ['production payment enablement', 'enabled: true']
];
for (const [label, needle] of forbidden) {
  if (source.includes(needle)) throw new Error(`Block 6 verification failed: ${label}`);
}
console.log('Block 6 generated server verification passed');
