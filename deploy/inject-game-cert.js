// Inject the game.cubit.cash LE cert/key (managed by Caddy) into the HYTOPIA SDK,
// which hardcodes a *.hytopiahosting.com cert. Replaces both $k (key) and Zk (cert),
// used by the HTTPS/2 server AND the WebTransport HTTP/3 server. Re-run after renewal.
const fs=require('fs');
const SDK='/opt/cubit/node_modules/hytopia/server.mjs';
const base=process.env.GAME_CERT_BASE||'/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/game.cubit.cash/game.cubit.cash';
const cert=fs.readFileSync(base+'.crt','utf8').trim();
const key=fs.readFileSync(base+'.key','utf8').trim();
let s=fs.readFileSync(SDK,'utf8');const b=s;
s=s.replace(/Zk=`-----BEGIN CERTIFICATE-----[\s\S]*?`/, ()=>'Zk=`'+cert+'\n`');
s=s.replace(/\$k=`-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?`/, ()=>'$k=`'+key+'\n`');
if(s===b){console.error('PATCH FAILED: cert/key patterns not found');process.exit(1);}
fs.writeFileSync(SDK,s);
console.log('patched OK; CERT blocks now:',(s.match(/BEGIN CERTIFICATE/g)||[]).length);
