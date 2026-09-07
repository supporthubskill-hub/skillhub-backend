const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');
let source = fs.readFileSync(serverPath, 'utf8');

const startMarker = '// BLOCK8_DELEGATED_SANDBOX_READY';
const endMarker = "app.get('/api/payments/bookings/:id', auth, allow('user'), async (req, res, next) => {";
const start = source.indexOf(startMarker);
const end = start >= 0 ? source.indexOf(endMarker, start) : -1;

if (start < 0 || end < 0) {
  throw new Error('Block 8 delegated output fix failed: generated block not found');
}

let block = source.slice(start, end);
block = block.split('\\`').join('`');
block = block.split('\\\\').join('\\');
source = source.slice(0, start) + block + source.slice(end);

fs.writeFileSync(serverPath, source, 'utf8');
console.log('Block 8 delegated sandbox output normalized');
