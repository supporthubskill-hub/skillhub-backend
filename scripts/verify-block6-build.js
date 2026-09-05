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
  ['provider member since', 'memberSince']
];

for (const [label, needle] of required) {
  if (!source.includes(needle)) throw new Error(`Block 6 verification failed: ${label}`);
}

if (source.includes('birth_date AS "birthDate"')) throw new Error('Block 6 verification failed: public birth date exposure');
console.log('Block 6 generated server verification passed');
