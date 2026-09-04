const fs = require('fs');
const path = require('path');

const sourcePath = path.join(__dirname, '..', 'server.js');
const runtimePath = path.join(__dirname, '..', '.runtime-server.js');

function replaceOrThrow(source, needle, replacement, label) {
  if (!source.includes(needle)) {
    throw new Error(`Runtime server patch failed: ${label}`);
  }
  return source.replace(needle, replacement);
}

function buildRuntimeServer() {
  let source = fs.readFileSync(sourcePath, 'utf8');

  source = replaceOrThrow(
    source,
    "    CREATE INDEX IF NOT EXISTS idx_disputes_status_created ON disputes(status, created_at DESC);\n  `);",
    "    CREATE INDEX IF NOT EXISTS idx_disputes_status_created ON disputes(status, created_at DESC);\n    CREATE TABLE IF NOT EXISTS platform_settings (\n      key TEXT PRIMARY KEY,\n      value TEXT NOT NULL,\n      updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,\n      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()\n    );\n    INSERT INTO platform_settings(key,value) VALUES\n      ('commission_rate','0.10'),\n      ('brand_name','Zeqviro'),\n      ('support_email','support.hubskill@gmail.com'),\n      ('beta_mode','true')\n    ON CONFLICT(key) DO NOTHING;\n  `);",
    'platform settings table'
  );

  source = replaceOrThrow(
    source,
    "app.get('/api/payments/config', (_req, res) => {\n  res.json({\n    enabled: false,\n    mode: 'test_only',\n    currency: 'usd',\n    commissionRate: COMMISSION_RATE,\n    message: 'Los pagos reales todavía no están activados.'\n  });\n});",
    "app.get('/api/payments/config', async (_req, res, next) => {\n  try {\n    const { rows } = await pool.query(\"SELECT value FROM platform_settings WHERE key='commission_rate'\");\n    const commissionRate = Number(rows[0]?.value ?? COMMISSION_RATE);\n    res.json({\n      enabled: false,\n      mode: 'test_only',\n      currency: 'usd',\n      commissionRate: Number.isFinite(commissionRate) ? commissionRate : COMMISSION_RATE,\n      message: 'Los pagos reales todavía no están activados.'\n    });\n  } catch (e) { next(e); }\n});",
    'public payment configuration'
  );

  source = replaceOrThrow(
    source,
    "    const total = Number(services[0].price);\n    const platformFee = Number((total * COMMISSION_RATE).toFixed(2));\n    const providerAmount = Number((total - platformFee).toFixed(2));",
    "    const total = Number(services[0].price);\n    const { rows: commissionRows } = await client.query(\"SELECT value FROM platform_settings WHERE key='commission_rate'\");\n    const configuredRate = Number(commissionRows[0]?.value ?? COMMISSION_RATE);\n    const commissionRate = Number.isFinite(configuredRate) ? Math.min(Math.max(configuredRate, 0), 0.30) : COMMISSION_RATE;\n    const platformFee = Number((total * commissionRate).toFixed(2));\n    const providerAmount = Number((total - platformFee).toFixed(2));",
    'booking commission calculation'
  );

  const adminSettingsRoutes = `app.get('/api/admin/settings', auth, allow('admin'), async (_req, res, next) => {
  try {
    const { rows } = await pool.query(\`SELECT key,value,updated_at AS "updatedAt" FROM platform_settings WHERE key IN ('commission_rate','brand_name','support_email','beta_mode')\`);
    const settings = Object.fromEntries(rows.map((row) => [row.key, row]));
    const commissionRate = Number(settings.commission_rate?.value ?? COMMISSION_RATE);
    res.json({
      commissionRate: Number.isFinite(commissionRate) ? commissionRate : COMMISSION_RATE,
      commissionPercent: Number(((Number.isFinite(commissionRate) ? commissionRate : COMMISSION_RATE) * 100).toFixed(2)),
      brandName: settings.brand_name?.value || 'Zeqviro',
      supportEmail: settings.support_email?.value || 'support.hubskill@gmail.com',
      betaMode: String(settings.beta_mode?.value || 'true') === 'true',
      commissionUpdatedAt: settings.commission_rate?.updatedAt || null
    });
  } catch (e) { next(e); }
});

app.patch('/api/admin/settings/commission', auth, allow('admin'), async (req, res, next) => {
  try {
    const percent = Number(req.body.percent);
    if (!Number.isFinite(percent) || percent < 0 || percent > 30) {
      return res.status(400).json({ error: 'La comisión debe estar entre 0% y 30%' });
    }
    const normalizedPercent = Number(percent.toFixed(2));
    const rate = Number((normalizedPercent / 100).toFixed(4));
    const result = await withTransaction(async (client) => {
      const { rows: currentRows } = await client.query(\"SELECT value FROM platform_settings WHERE key='commission_rate' FOR UPDATE\");
      const oldRate = Number(currentRows[0]?.value ?? COMMISSION_RATE);
      await client.query(\`INSERT INTO platform_settings(key,value,updated_by,updated_at)
        VALUES('commission_rate',$1,$2,NOW())
        ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=NOW()\`, [String(rate), req.user.id]);
      const oldPercent = Number(((Number.isFinite(oldRate) ? oldRate : COMMISSION_RATE) * 100).toFixed(2));
      const reason = \`Comisión de Zeqviro: \${oldPercent}% → \${normalizedPercent}%\`;
      await client.query(\`INSERT INTO admin_actions(admin_id,action,target_type,target_id,reason)
        VALUES($1,'commission_rate_changed','setting',0,$2)\`, [req.user.id, reason]);
      return { oldPercent, normalizedPercent, rate };
    });
    res.json({
      commissionRate: result.rate,
      commissionPercent: result.normalizedPercent,
      previousCommissionPercent: result.oldPercent,
      message: 'Comisión actualizada. Se aplicará a nuevas reservas.'
    });
  } catch (e) { next(e); }
});

`;

  source = replaceOrThrow(
    source,
    "app.get('/api/admin/activity', auth, allow('admin'), async (_req, res, next) => {",
    adminSettingsRoutes + "app.get('/api/admin/activity', auth, allow('admin'), async (_req, res, next) => {",
    'admin platform settings routes'
  );

  source = source.replaceAll('SkillHub API listening on', 'Zeqviro API listening on');

  fs.writeFileSync(runtimePath, source, 'utf8');
  return runtimePath;
}

module.exports = { buildRuntimeServer };
