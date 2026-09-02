require('dotenv').config();
const { Pool } = require('pg');

const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
if (!process.env.DATABASE_URL) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}
if (!email) {
  console.error('Missing ADMIN_EMAIL');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

(async () => {
  try {
    const { rows } = await pool.query(
      `UPDATE users
       SET role='admin'
       WHERE lower(email)=lower($1)
       RETURNING id,email,role,name`,
      [email]
    );

    if (!rows[0]) {
      console.error(`No existe una cuenta con el correo ${email}. Registra esa cuenta primero y vuelve a ejecutar este comando.`);
      process.exitCode = 2;
      return;
    }

    console.log(`Admin activado: ${rows[0].email}`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
