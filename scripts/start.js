require('dotenv').config();
const { Pool } = require('pg');

const BRAND_NAME = 'Zeqviro';
const LEGACY_BRAND_NAME = 'SkillHub';
const applyBrand = (value) => typeof value === 'string'
  ? value.replaceAll(LEGACY_BRAND_NAME, BRAND_NAME)
  : value;

function enableResendMailTransport() {
  const apiKey = String(process.env.RESEND_API_KEY || '').trim();
  if (!apiKey) return;

  const nodemailer = require('nodemailer');
  process.env.SMTP_USER ||= 'resend-api';
  process.env.SMTP_PASS ||= 'resend-api';

  nodemailer.createTransport = () => ({
    async sendMail(message) {
      const from = String(process.env.RESEND_FROM || process.env.EMAIL_FROM || '').trim();
      if (!from) throw new Error('RESEND_FROM is required when Resend is enabled');

      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from,
          to: Array.isArray(message.to) ? message.to : [message.to],
          subject: applyBrand(message.subject),
          text: applyBrand(message.text),
          html: applyBrand(message.html)
        }),
        signal: AbortSignal.timeout(12000)
      });

      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        const safeMessage = String(detail?.message || 'Resend rejected the email').slice(0, 180);
        throw new Error(`Email provider error: ${safeMessage}`);
      }

      const result = await response.json().catch(() => ({}));
      return { messageId: result.id || null };
    }
  });

  console.log('Email verification delivery: Resend API enabled');
}

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
      console.warn(`ADMIN_EMAIL is configured, but no matching ${BRAND_NAME} account exists for ${email}`);
    }
  } finally {
    await pool.end();
  }
}

(async () => {
  try {
    enableResendMailTransport();
    await promoteConfiguredAdmin();
    require('../server');
  } catch (err) {
    console.error(`Startup failed: ${err.message}`);
    process.exit(1);
  }
})();
