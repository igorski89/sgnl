# AWS SES inbound + outbound — Terraform

Provisions:
- SES domain identity + DKIM in the **sending** region (outbound —
  matches `../.kamal/secrets`' `AWS_SES_SMTP_USERNAME`/`PASSWORD`).
- An SES receipt rule set + rule in the **receiving** region: writes raw
  inbound messages to S3, then invokes a Lambda that relays them into
  Stalwart over authenticated SMTP submission.
- The S3 bucket, IAM roles, a Secrets Manager *container* for the relay
  password (value set manually, see below), and a CloudWatch alarm + SNS
  email subscription so a stuck forwarder actually reaches you.

**Nothing has been applied.** This needs real AWS credentials — **not
root's**. See `bootstrap/README.md` first: it walks root through
creating a properly-scoped IAM user (`example-sgnl-terraform`, policy in
`bootstrap/terraform-policy.json`) via CloudShell, so a root access key
never has to exist. Everything below assumes that's done and the
key is in the Keychain (`bootstrap/README.md` step 3), where `./tf` and
`./awscli` pick it up.

## Before `terraform apply`

1. `cd lambda/forwarder && npm install` — installs `nodemailer`, whose
   compiled `node_modules/` gets zipped into the Lambda package by
   Terraform's `archive_file` data source. Skip this and `apply` ships a
   function that can't `import nodemailer`.
2. `cp terraform.tfvars.example terraform.tfvars`, fill in
   `notification_email` at minimum.

Everything runs in one region, `eu-central-1` (SES supports receiving
there). The `example.com` identity, its DKIM and the custom MAIL
FROM existed before this project and stay outside Terraform; see the
comment at the top of `ses.tf`.

Commands below use `./tf` and `./awscli` — wrappers around the official
`hashicorp/terraform` / `amazon/aws-cli` Docker images (see `./tf`,
`./awscli`), so neither needs to be installed locally. Swap in bare
`terraform`/`aws` if you have them installed natively instead.

## After `terraform apply`

1. Nothing to copy into DNS yet. `mx_target` is only needed at the MX
   switch (`../docs/DEPLOY.md` step 3).
2. The Lambda logs in to Stalwart as `ses-relay@example.com` with
   an **app password**. `../bin/stalwart-relay-app-password` creates it in
   Stalwart, stores it in the Keychain
   (`example-sgnl-ses-relay-app-password`) and writes it into
   Secrets Manager. Terraform never sees it, and the operator key can
   write the secret but not read it back. Re-run the script to rotate:
   it hands the new one to the Lambda before deleting the old one.
3. Once DNS has propagated, send yourself a test email from an external
   address. Watch it land:
   ```bash
   ./awscli logs tail /aws/lambda/example-sgnl-ses-forwarder --follow --region eu-central-1
   ```

## Replaying failed messages

Lambda retries a failed relay twice (async invocation), then parks the
original SES event in the `example-sgnl-ses-forwarder-dlq` SQS queue, and the
`example-sgnl-ses-forwarder-dlq` alarm emails you. The raw message itself is
still in S3 the whole time; the DLQ entry just records which one. Once
Stalwart is reachable again, replay one entry at a time:

```bash
./awscli sqs receive-message --region eu-central-1 \
  --queue-url "$(./tf output -raw forwarder_dlq_url)" \
  --max-number-of-messages 1 > dlq.json
jq -r '.Messages[0].Body | fromjson | .requestPayload' dlq.json > replay-event.json
./awscli lambda invoke --region eu-central-1 \
  --function-name example-sgnl-ses-forwarder --invocation-type Event \
  --payload fileb://replay-event.json /dev/null
# Once `logs tail` shows "relayed <messageId> -> ...", drop the entry:
./awscli sqs delete-message --region eu-central-1 \
  --queue-url "$(./tf output -raw forwarder_dlq_url)" \
  --receipt-handle "$(jq -r '.Messages[0].ReceiptHandle' dlq.json)"
rm dlq.json replay-event.json
```

Entries are kept 14 days (the SQS maximum). A recipient that Stalwart
rejects permanently (5xx, e.g. a mistyped address on our domain) is
logged as `rejected ...` and *not* retried or sent to the DLQ, since it
would fail the same way every time.

## Not verified against a live account

Flagging plainly rather than asserting false confidence — none of this
has been deploy-tested:
- Whether the receiving-region rule genuinely needs no verified identity
  (see the comment in `ses.tf`).
- The exact `scan_enabled` / `s3_action` / `lambda_action` block shapes
  on `aws_ses_receipt_rule` — check against whatever `hashicorp/aws`
  provider version `main.tf` resolves to (`~> 5.0`).
- `aws/lambda/forwarder/index.mjs` has run once, locally, against a
  real Stalwart 0.16.25 on 465 (S3/Secrets Manager stubbed, hand-built
  SES event). The envelope sender was preserved, both `receipt.recipients`
  were delivered, and the Cc'd external address in `mail.destination` was
  not contacted. It has not run inside Lambda or on a real SES event.
  Node verifies Stalwart's certificate, so the Let's Encrypt cert on
  `mail.sgnl` must be issued before the first relay can succeed.
