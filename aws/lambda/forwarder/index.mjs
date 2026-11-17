import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import nodemailer from "nodemailer";

// Relays SES-received mail into Stalwart over authenticated SMTP
// submission. Never run against real traffic - see ../../README.md's
// "Not verified against a live account" section before trusting this.
//
// Design choice: never silently drop a message on a bad spam/virus
// verdict - tag it with the verdict as headers and still deliver, so a
// false positive doesn't just vanish a real client email with no trace.
// Filter on those headers in Stalwart's own Sieve rules downstream if
// you want that instead.

const s3 = new S3Client({});
const secretsManager = new SecretsManagerClient({});

const BUCKET = process.env.INBOUND_BUCKET;
const PREFIX = process.env.INBOUND_PREFIX ?? "incoming/";
const STALWART_HOST = process.env.STALWART_HOST;
const STALWART_PORT = Number(process.env.STALWART_PORT ?? 465);
const RELAY_USERNAME = process.env.RELAY_USERNAME;
const RELAY_SECRET_ARN = process.env.RELAY_SECRET_ARN;

let cachedPassword;
async function relayPassword() {
  if (!cachedPassword) {
    const res = await secretsManager.send(
      new GetSecretValueCommand({ SecretId: RELAY_SECRET_ARN }),
    );
    cachedPassword = res.SecretString;
  }
  return cachedPassword;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function withVerdictHeaders(raw, receipt) {
  const lines = [
    `X-SES-Spam-Verdict: ${receipt.spamVerdict?.status ?? "UNKNOWN"}`,
    `X-SES-Virus-Verdict: ${receipt.virusVerdict?.status ?? "UNKNOWN"}`,
    `X-SES-SPF-Verdict: ${receipt.spfVerdict?.status ?? "UNKNOWN"}`,
    `X-SES-DKIM-Verdict: ${receipt.dkimVerdict?.status ?? "UNKNOWN"}`,
    `X-SES-DMARC-Verdict: ${receipt.dmarcVerdict?.status ?? "UNKNOWN"}`,
  ];
  return Buffer.concat([Buffer.from(lines.join("\r\n") + "\r\n"), raw]);
}

export const handler = async (event) => {
  const transport = nodemailer.createTransport({
    host: STALWART_HOST,
    port: STALWART_PORT,
    // Implicit TLS on 465 (Stalwart 0.16's default submission listener):
    // TLS from the first byte, so there's no STARTTLS step to strip.
    secure: true,
    auth: { user: RELAY_USERNAME, pass: await relayPassword() },
  });

  for (const record of event.Records ?? []) {
    const { mail, receipt } = record.ses;
    const messageId = mail.messageId;

    const obj = await s3.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: `${PREFIX}${messageId}` }),
    );
    const raw = withVerdictHeaders(await streamToBuffer(obj.Body), receipt);

    // receipt.recipients, NOT mail.destination: destination is parsed
    // from the To/Cc headers, so it misses Bcc'd recipients and includes
    // external addresses (a client Cc'ing a colleague) - relaying those
    // through the authenticated submission port would make Stalwart send
    // them back out via SES. recipients is the envelope RCPT TO list that
    // matched our receipt rule, i.e. exactly our own addresses.
    const recipients = receipt.recipients;

    // One SMTP transaction for all recipients, so a retry doesn't
    // re-deliver to recipients that already succeeded in an earlier loop
    // iteration. Throwing here fails the Lambda invocation and lets
    // Lambda's async retry handle it; after retries are exhausted the
    // event lands in the DLQ (see ../../lambda.tf). The raw message is
    // already durable in S3 regardless, so a transient Stalwart outage
    // never bounces the message back to the original sender - it just
    // arrives late.
    const info = await transport.sendMail({
      envelope: { from: mail.source, to: recipients },
      raw,
    });

    // nodemailer only throws if *every* recipient is rejected; partial
    // rejections come back here. Temporary (4xx) ones are worth a retry
    // even at the cost of a duplicate for the accepted recipients;
    // permanent (5xx, e.g. unknown mailbox) ones would just fail again.
    const rejected = info.rejectedErrors ?? [];
    for (const err of rejected) {
      console.error(
        `rejected ${messageId} -> ${err.recipient}: ${err.responseCode} ${err.response}`,
      );
    }
    if (rejected.some((err) => err.responseCode >= 400 && err.responseCode < 500)) {
      throw new Error(`temporary rejection relaying ${messageId}, retrying`);
    }
    console.log(`relayed ${messageId} -> ${info.accepted.join(", ")}`);
  }
};
