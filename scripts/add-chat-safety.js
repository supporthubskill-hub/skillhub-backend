const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');
let source = fs.readFileSync(serverPath, 'utf8');

function replaceOnce(needle, replacement, label) {
  if (source.includes(replacement)) return;
  if (!source.includes(needle)) throw new Error(`Chat safety patch failed: ${label}`);
  source = source.replace(needle, replacement);
}

function insertBefore(needle, addition, label) {
  if (source.includes(addition.trim())) return;
  if (!source.includes(needle)) throw new Error(`Chat safety patch failed: ${label}`);
  source = source.replace(needle, addition + needle);
}

const usersIndex = "    CREATE INDEX IF NOT EXISTS idx_users_account_identity ON users(account_status, identity_status);";
const blockSchema = `    CREATE TABLE IF NOT EXISTS user_blocks (\n      blocker_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,\n      blocked_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,\n      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),\n      PRIMARY KEY(blocker_id, blocked_id),\n      CHECK (blocker_id <> blocked_id)\n    );\n    CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks(blocked_id);\n${usersIndex}`;
replaceOnce(usersIndex, blockSchema, 'user block schema');

const messageValidation = "    if (!Number.isInteger(serviceId) || body.length < 1 || body.length > 1000) {\n      return res.status(400).json({ error: 'Escribe un mensaje de 1 a 1000 caracteres' });\n    }";
const safeMessageValidation = `${messageValidation}\n    const sensitiveContact = /(?:\\b(?:\\+?1[-.\\s]?)?(?:\\(?\\d{3}\\)?[-.\\s]?)\\d{3}[-.\\s]?\\d{4}\\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}|(?:instagram|insta|snapchat|snap|tiktok|telegram|whatsapp)\\s*[:@]?\\s*[A-Z0-9._-]{2,})/i.test(body);\n    if (isYouthAccount(req.user) && sensitiveContact) {\n      return res.status(400).json({ error: 'Por seguridad, las cuentas juveniles no pueden compartir teléfonos, correos ni contactos externos en el chat.', code: 'YOUTH_CONTACT_SHARING_BLOCKED' });\n    }`;
replaceOnce(messageValidation, safeMessageValidation, 'youth contact-sharing guard');

const providerRecipientCheck = `      recipientId = Number(req.body.recipientId);\n      const { rows: prior } = await pool.query(\`SELECT 1 FROM messages WHERE service_id=$1\n        AND ((sender_id=$2 AND recipient_id=$3) OR (sender_id=$3 AND recipient_id=$2)) LIMIT 1\`,\n        [serviceId, req.user.id, recipientId]);\n      if (!Number.isInteger(recipientId) || !prior[0]) return res.status(403).json({ error: 'Conversación no autorizada' });`;
const providerRecipientCheckNew = `      recipientId = Number(req.body.recipientId);\n      if (!Number.isInteger(recipientId)) return res.status(403).json({ error: 'Conversación no autorizada' });\n      const { rows: prior } = await pool.query(\`SELECT 1 FROM messages WHERE service_id=$1\n        AND ((sender_id=$2 AND recipient_id=$3) OR (sender_id=$3 AND recipient_id=$2)) LIMIT 1\`,\n        [serviceId, req.user.id, recipientId]);\n      if (!prior[0]) return res.status(403).json({ error: 'Conversación no autorizada' });`;
replaceOnce(providerRecipientCheck, providerRecipientCheckNew, 'provider recipient validation');

const recipientSelfCheck = "    if (String(recipientId) === String(req.user.id)) return res.status(400).json({ error: 'No puedes contactarte a ti mismo' });";
const blockCheck = `${recipientSelfCheck}\n    const { rows: blockedRows } = await pool.query(\`SELECT 1 FROM user_blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1) LIMIT 1\`, [req.user.id, recipientId]);\n    if (blockedRows[0]) return res.status(403).json({ error: 'Esta conversación está bloqueada.', code: 'CHAT_BLOCKED' });`;
replaceOnce(recipientSelfCheck, blockCheck, 'message block guard');

const conversationsWhere = "      WHERE m.sender_id=$1 OR m.recipient_id=$1";
const conversationsWhereSafe = `      WHERE (m.sender_id=$1 OR m.recipient_id=$1)\n        AND NOT EXISTS (SELECT 1 FROM user_blocks ub WHERE (ub.blocker_id=$1 AND ub.blocked_id=CASE WHEN m.sender_id=$1 THEN m.recipient_id ELSE m.sender_id END) OR (ub.blocked_id=$1 AND ub.blocker_id=CASE WHEN m.sender_id=$1 THEN m.recipient_id ELSE m.sender_id END))`;
replaceOnce(conversationsWhere, conversationsWhereSafe, 'hide blocked conversations');

const messagesQueryTail = "      AND ((m.sender_id=$2 AND m.recipient_id=$3) OR (m.sender_id=$3 AND m.recipient_id=$2))\n      ORDER BY m.created_at ASC`, [serviceId, req.user.id, otherUserId]);";
const messagesQueryTailSafe = "      AND ((m.sender_id=$2 AND m.recipient_id=$3) OR (m.sender_id=$3 AND m.recipient_id=$2))\n      AND NOT EXISTS (SELECT 1 FROM user_blocks ub WHERE (ub.blocker_id=$2 AND ub.blocked_id=$3) OR (ub.blocker_id=$3 AND ub.blocked_id=$2))\n      ORDER BY m.created_at ASC`, [serviceId, req.user.id, otherUserId]);";
replaceOnce(messagesQueryTail, messagesQueryTailSafe, 'message history block guard');

const routes = `// ZEQVIRO_CHAT_SAFETY_ROUTES\napp.get('/api/blocks', auth, allow('user'), async (req,res,next)=>{\n  try {\n    const { rows } = await pool.query(\`SELECT ub.blocked_id AS "userId",u.name,ub.created_at AS "createdAt" FROM user_blocks ub JOIN users u ON u.id=ub.blocked_id WHERE ub.blocker_id=$1 ORDER BY ub.created_at DESC\`, [req.user.id]);\n    res.json({ blocks: rows });\n  } catch (e) { next(e); }\n});\napp.post('/api/blocks/:userId', auth, allow('user'), async (req,res,next)=>{\n  try {\n    const blockedId=Number(req.params.userId);\n    if(!Number.isInteger(blockedId)||blockedId===Number(req.user.id)) return res.status(400).json({error:'Usuario inválido.'});\n    const { rows: userRows } = await pool.query("SELECT id FROM users WHERE id=$1 AND role!='admin'", [blockedId]);\n    if(!userRows[0]) return res.status(404).json({error:'Usuario no encontrado.'});\n    await pool.query('INSERT INTO user_blocks(blocker_id,blocked_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[req.user.id,blockedId]);\n    res.status(201).json({blocked:true,userId:blockedId});\n  } catch(e){ next(e); }\n});\napp.delete('/api/blocks/:userId', auth, allow('user'), async (req,res,next)=>{\n  try {\n    const blockedId=Number(req.params.userId);\n    if(!Number.isInteger(blockedId)) return res.status(400).json({error:'Usuario inválido.'});\n    await pool.query('DELETE FROM user_blocks WHERE blocker_id=$1 AND blocked_id=$2',[req.user.id,blockedId]);\n    res.status(204).end();\n  } catch(e){ next(e); }\n});\n`;
insertBefore("app.get('/api/security/me', auth, async (req, res, next) => {", routes, 'chat safety routes');

fs.writeFileSync(serverPath, source, 'utf8');
console.log('Chat safety patch applied');
