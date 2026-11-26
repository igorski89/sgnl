// Dev environments only (bin/sgnl-dev inbound): delivers one .eml as if SES had received it, through the REAL
// forwarder code (aws/lambda/forwarder/index.mjs). Its S3 read and its Secrets Manager read are answered locally
// (the file, the relay app password); the SMTP part, the verdict headers and the envelope are the Lambda's own.
//
//   RELAY_PASSWORD_FILE=<file> STALWART_HOST=mail.<apps> RELAY_USERNAME=ses-relay@<domain> \
//     node inbound.mjs <file.eml> <from> <rcpt>[,<rcpt>...]
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fwd = path.join(here, '..', '..', 'aws', 'lambda', 'forwarder');
const [EML, FROM, RCPTS] = process.argv.slice(2);
if (!EML || !FROM || !RCPTS || !process.env.STALWART_HOST?.endsWith('.test')) {
  console.error('usage: STALWART_HOST=mail.<apps>.test ... node inbound.mjs <file.eml> <from> <rcpt>[,...]');
  process.exit(64);
}
const raw = fs.readFileSync(EML);
const password = fs.readFileSync(process.env.RELAY_PASSWORD_FILE, 'utf8').trim();

// The same SDK module instances the forwarder imports (its own node_modules).
const req = (m) => import(pathToFileURL(path.join(fwd, 'node_modules', ...m.split('/'), 'dist-cjs', 'index.js')).href);
const s3 = await req('@aws-sdk/client-s3');
const sm = await req('@aws-sdk/client-secrets-manager');
s3.S3Client.prototype.send = async () => ({ Body: Readable.from([raw]) });
sm.SecretsManagerClient.prototype.send = async () => ({ SecretString: password });

process.env.INBOUND_BUCKET ??= 'dev-local';
process.env.RELAY_SECRET_ARN ??= 'dev-local';
const { handler } = await import(pathToFileURL(path.join(fwd, 'index.mjs')).href);
const messageId = 'dev-' + Date.now();
const pass = { status: 'PASS' };
await handler({ Records: [{ ses: {
  mail: { messageId, source: FROM },
  receipt: { recipients: RCPTS.split(','), spamVerdict: pass, virusVerdict: pass, spfVerdict: pass, dkimVerdict: pass, dmarcVerdict: pass },
} }] });
