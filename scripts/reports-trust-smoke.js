const fs=require('fs');
const p=require('path');
const files=['scripts/add-reports-trust.js','package.json'];
for(const f of files){if(!fs.existsSync(p.join(__dirname,'..',f)))throw new Error(`Missing ${f}`)}
const s=fs.readFileSync(p.join(__dirname,'add-reports-trust.js'),'utf8');
for(const needle of ["app.post('/api/reports'","app.get('/api/reports/me'","app.get('/api/admin/reports'","ACCOUNT_SUSPENDED","INSERT INTO user_notifications(user_id,title,body)"]){if(!s.includes(needle))throw new Error(`Missing ${needle}`)}
console.log('Reports/trust static smoke OK');
