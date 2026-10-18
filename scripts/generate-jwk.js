import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const envPath = path.join(rootDir, '.env');
const jwkPath = path.join(rootDir, 'krakend', 'jwk.json');

if (!fs.existsSync(envPath)) {
  console.error('❌ Error: File .env not found in project root!');
  console.error('👉 Please copy .env.example to .env and set JWT_ACCESS_SECRET first:');
  console.error('   cp .env.example .env\n');
  process.exit(1);
}

const envContent = fs.readFileSync(envPath, 'utf8');
const match = envContent.match(/^\s*JWT_ACCESS_SECRET\s*=\s*["']?([^"'\r\n]+)["']?/m);
const jwtSecret = match ? match[1].trim() : '';

if (!jwtSecret) {
  console.error('❌ Error: JWT_ACCESS_SECRET is empty or missing in .env!');
  console.error('👉 Please set a valid JWT_ACCESS_SECRET in .env and run this command again.\n');
  process.exit(1);
}

// Convert JWT_ACCESS_SECRET to Base64URL encoding (RFC 7517 for oct key)
const base64UrlSecret = Buffer.from(jwtSecret, 'utf-8').toString('base64url');

const jwkData = {
  keys: [
    {
      kty: 'oct',
      k: base64UrlSecret,
      alg: 'HS256',
      use: 'sig'
    }
  ]
};

const krakendDir = path.dirname(jwkPath);
if (!fs.existsSync(krakendDir)) {
  fs.mkdirSync(krakendDir, { recursive: true });
}

fs.writeFileSync(jwkPath, JSON.stringify(jwkData, null, 2) + '\n', 'utf8');

console.log('✅ Generated krakend/jwk.json successfully from JWT_ACCESS_SECRET in .env!');
console.log(`🔑 Key length: ${jwtSecret.length} chars (Base64URL: ${base64UrlSecret.length} chars)`);
console.log('💡 Note: If KrakenD gateway is running, run `docker compose restart krakend` to reload the new key.\n');
