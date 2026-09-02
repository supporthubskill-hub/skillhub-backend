require('dotenv').config();
const { Pool } = require('pg');

async function promoteConfiguredAdmin() {
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!email) return;
  if (!process.env.DATABASE_URL) throw new Error('Missing DATABASE_URL');

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  });

  try {
    const { rows } = await pool.query(
      `UPDATE users
       SET role='admin'
       WHERE lower(email)=lower($1)
       RETURNING id,email,role,name`,
      [email]
    );

    if (rows[0]) {
      console.log(`Admin startup promotion confirmed for ${rows[0].email}`);
    } else {
      console.warn(`ADMIN_EMAIL is configured, but no matching SkillHub account exists for ${email}`);
    }
  } finally {
    await pool.end();
  }
}

(async () => {
  try {
    await promoteConfiguredAdmin();
    require('../server');
  } catch (err) {
    console.error(`Startup failed: ${err.message}`);
    process.exit(1);
  }
})();
