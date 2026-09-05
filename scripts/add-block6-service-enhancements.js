const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');
let source = fs.readFileSync(serverPath, 'utf8');

function replaceOnce(needle, replacement, label) {
  if (source.includes(replacement)) return;
  if (!source.includes(needle)) throw new Error(`Block 6 service patch failed: ${label}`);
  source = source.replace(needle, replacement);
}

replaceOnce(
  "    ALTER TABLE services ADD COLUMN IF NOT EXISTS paused BOOLEAN NOT NULL DEFAULT FALSE;",
  "    ALTER TABLE services ADD COLUMN IF NOT EXISTS paused BOOLEAN NOT NULL DEFAULT FALSE;\n    ALTER TABLE services ADD COLUMN IF NOT EXISTS image_url TEXT NOT NULL DEFAULT '';",
  'service image column'
);

replaceOnce(
  `      s.price::float,s.hourly_price::float AS hourly,CASE WHEN u.age_band IN ('14_15','16_17') THEN 'Remoto' ELSE s.area END AS area,u.name AS \"providerName\",u.id AS \"providerId\",`,
  `      s.price::float,s.hourly_price::float AS hourly,CASE WHEN u.age_band IN ('14_15','16_17') THEN 'Remoto' ELSE s.area END AS area,s.image_url AS \"imageUrl\",u.name AS \"providerName\",u.id AS \"providerId\",`,
  'public service image'
);

replaceOnce(
  `        s.price::float,s.hourly_price::float AS hourly,s.area,s.active,s.paused,s.created_at AS \"createdAt\",`,
  `        s.price::float,s.hourly_price::float AS hourly,s.area,s.image_url AS \"imageUrl\",s.active,s.paused,s.created_at AS \"createdAt\",`,
  'provider service image'
);

replaceOnce(
  `    area: String(req.body.area || 'Remoto').trim()\n  };`,
  `    area: String(req.body.area || 'Remoto').trim(),\n    imageUrl: String(req.body.imageUrl || '').trim().slice(0, 500)\n  };`,
  'service input image'
);

replaceOnce(
  `    Number.isFinite(v.hourly) && v.hourly >= 0 && v.area.length <= 150;`,
  `    Number.isFinite(v.hourly) && v.hourly >= 0 && v.area.length <= 150 &&\n    (!v.imageUrl || /^https:\\/\\//i.test(v.imageUrl));`,
  'service image validation'
);

replaceOnce(
  `      const { rows } = await client.query(\`INSERT INTO services(provider_id,name,description,category,service_type,price,hourly_price,area)\n        VALUES($1,$2,$3,$4,$5,$6,$7,$8)\n        RETURNING id,name,description AS desc,category AS cat,service_type AS type,price::float,hourly_price::float AS hourly,area,active,created_at AS \"createdAt\"\`,\n        [req.user.id, v.name, v.desc, v.cat, v.type, v.price, v.hourly, v.area]);`,
  `      const { rows } = await client.query(\`INSERT INTO services(provider_id,name,description,category,service_type,price,hourly_price,area,image_url)\n        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)\n        RETURNING id,name,description AS desc,category AS cat,service_type AS type,price::float,hourly_price::float AS hourly,area,image_url AS \"imageUrl\",active,created_at AS \"createdAt\"\`,\n        [req.user.id, v.name, v.desc, v.cat, v.type, v.price, v.hourly, v.area, v.imageUrl]);`,
  'service create image'
);

replaceOnce(
  `    const { rows } = await pool.query(\`UPDATE services SET name=$1,description=$2,category=$3,service_type=$4,price=$5,hourly_price=$6,area=$7\n      WHERE id=$8 AND provider_id=$9\n      RETURNING id,name,description AS desc,category AS cat,service_type AS type,price::float,hourly_price::float AS hourly,area,active,created_at AS \"createdAt\"\`,\n      [v.name,v.desc,v.cat,v.type,v.price,v.hourly,v.area,req.params.id,req.user.id]);`,
  `    const { rows } = await pool.query(\`UPDATE services SET name=$1,description=$2,category=$3,service_type=$4,price=$5,hourly_price=$6,area=$7,image_url=$8\n      WHERE id=$9 AND provider_id=$10\n      RETURNING id,name,description AS desc,category AS cat,service_type AS type,price::float,hourly_price::float AS hourly,area,image_url AS \"imageUrl\",active,created_at AS \"createdAt\"\`,\n      [v.name,v.desc,v.cat,v.type,v.price,v.hourly,v.area,v.imageUrl,req.params.id,req.user.id]);`,
  'service update image'
);

replaceOnce(
  `SELECT id,name,description AS desc,price::float,area FROM services WHERE provider_id=$1 AND active=TRUE AND COALESCE(paused,FALSE)=FALSE ORDER BY created_at DESC`,
  `SELECT id,name,description AS desc,category AS cat,service_type AS type,price::float,hourly_price::float AS hourly,area,image_url AS \"imageUrl\",\n      EXISTS (SELECT 1 FROM availability a WHERE a.service_id=services.id AND a.available=TRUE AND a.starts_at>NOW()) AS \"hasAvailability\"\n      FROM services WHERE provider_id=$1 AND active=TRUE AND COALESCE(paused,FALSE)=FALSE ORDER BY created_at DESC`,
  'public provider service details'
);

fs.writeFileSync(serverPath, source, 'utf8');
console.log('Block 6 service enhancements applied');
