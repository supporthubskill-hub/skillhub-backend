#!/usr/bin/env node

const baseUrl = (process.env.SKILLHUB_API_URL || 'http://localhost:4000').replace(/\/$/, '');

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`);
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${path} did not return JSON (HTTP ${response.status})`);
  }
  if (!response.ok) {
    throw new Error(`${path} failed with HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function main() {
  const health = await getJson('/api/health');
  if (health.status !== 'ok') {
    throw new Error(`Unexpected health response: ${JSON.stringify(health)}`);
  }

  const payments = await getJson('/api/payments/config');
  if (payments.enabled !== false) {
    throw new Error('Controlled beta safety check failed: real payments appear to be enabled.');
  }
  if (payments.mode !== 'test_only') {
    throw new Error(`Expected payment mode "test_only", received ${JSON.stringify(payments.mode)}`);
  }

  console.log(`✓ Health check passed: ${baseUrl}/api/health`);
  console.log('✓ Controlled beta payment guard passed: real payments are disabled');
}

main().catch((error) => {
  console.error(`✗ Beta smoke test failed: ${error.message}`);
  process.exit(1);
});
