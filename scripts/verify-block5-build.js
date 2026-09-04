const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');
const source = fs.readFileSync(serverPath, 'utf8');

const checks = [
  ['pre-registration verification', "app.post('/api/auth/register/email/send'"],
  ['server-side legal consent flag', 'const privacyAccepted = req.body.privacyAccepted === true;'],
  ['server-side consent timestamp', 'const privacyAcceptedAt = new Date().toISOString();'],
  ['age band persistence', 'birth_date,age_band,region,privacy_accepted_at'],
  ['auth age band', 'suspension_reason,age_band FROM users WHERE id=$1'],
  ['youth helper', "const isYouthAccount = (user) => ['14_15','16_17'].includes(user?.ageBand || user?.age_band || '');"],
  ['youth remote-only booking restriction', 'YOUTH_REMOTE_ONLY'],
  ['public youth location privacy', "profile.youthPrivacy = true;"],
  ['chat block schema', 'CREATE TABLE IF NOT EXISTS user_blocks'],
  ['chat block route', "app.post('/api/blocks/:userId'"],
  ['chat blocked message guard', "code: 'CHAT_BLOCKED'"],
  ['youth contact guard', "code: 'YOUTH_CONTACT_SHARING_BLOCKED'"],
  ['reports route', "app.post('/api/reports'"],
  ['booking request conversation', 'conversation: { serviceId: services[0].id, otherUserId: services[0].provider_id }'],
  ['paused service protection', 'COALESCE(s.paused,FALSE)=FALSE']
];

const missing = checks.filter(([, needle]) => !source.includes(needle));
if (missing.length) {
  console.error('Block 5 generated-server verification failed. Missing:');
  for (const [label] of missing) console.error(`- ${label}`);
  process.exit(1);
}

const forbidden = [
  ['client-provided consent timestamp', 'const acceptedAt = new Date(privacyAcceptedAt);'],
  ['legacy youth chat check', "req.user.ageBand && req.user.ageBand !== '18_plus' && sensitiveContact"]
];
const presentForbidden = forbidden.filter(([, needle]) => source.includes(needle));
if (presentForbidden.length) {
  console.error('Block 5 generated-server verification failed. Legacy patterns remain:');
  for (const [label] of presentForbidden) console.error(`- ${label}`);
  process.exit(1);
}

console.log(`Block 5 generated-server verification passed (${checks.length} checks).`);
