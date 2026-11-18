# From root access to a working `terraform apply` — one time only

Root should never run Terraform directly, and should never hold a
long-lived access key at all. This creates a properly-scoped IAM user
instead, using the AWS Console's built-in CloudShell (authenticated by
your console session) so a root access key never has to exist.

## 1. Lock root down first (console, as root)

1. **Enable MFA on the root user** if it isn't already: IAM → root user
   (top right, "Security credentials") → Assign MFA. This is the single
   highest-value security action available on this account — root can
   delete the account, remove billing protections, anything.
2. Same page → **Access keys**: confirm there are none. If any exist,
   delete them. Root should never have a long-lived key.
3. Optional but recommended while you're here: Billing → Budgets →
   create a small monthly budget alert. Costs from this stack are cents,
   but it's a cheap tripwire against a misconfiguration running away.

## 2. Create the scoped Terraform user (CloudShell, as root)

Open **CloudShell** (icon in the console's top nav bar) — this runs
under your root console session's credentials without ever generating a
root access key.

The policy file has `{{SGNL_PREFIX}}` placeholders; render it with this
instance's prefix first (from the repo root):

```bash
bin/sgnl-render aws/bootstrap/terraform-policy.json > /tmp/terraform-policy.json
```

Paste that rendered file in (CloudShell has a file upload button in
its menu, or just `cat > terraform-policy.json` and paste), then:

```bash
aws iam create-policy \
  --policy-name example-sgnl-terraform \
  --policy-document file://terraform-policy.json

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

aws iam create-user --user-name example-sgnl-terraform

aws iam attach-user-policy \
  --user-name example-sgnl-terraform \
  --policy-arn "arn:aws:iam::${ACCOUNT_ID}:policy/example-sgnl-terraform"

aws iam create-access-key --user-name example-sgnl-terraform
```

That last command prints an `AccessKeyId` and `SecretAccessKey` — **copy
both now**, they're shown exactly once. This key belongs to the scoped
`example-sgnl-terraform` user, not root, so it's fine to use long-term (rotate it
periodically same as any credential).

## 3. Store the key (your laptop)

`aws`/`terraform` aren't installed locally on purpose: `../tf` and
`../awscli` wrap the official `hashicorp/terraform` / `amazon/aws-cli`
Docker images. They read the key through `bin/sgnl-secret` (Vaultwarden) and pass it in
as environment variables (`../.docker-aws-env`), so it never exists as a
file: no `~/.aws/credentials`, nothing in the project. Run these in your
own terminal:

```bash
../bin/sgnl-unlock
../bin/sgnl-secret --set aws-access-key-id        # hidden prompt: paste AKIA..., Enter
../bin/sgnl-secret --set aws-secret-access-key

cd ..   # aws/
./awscli sts get-caller-identity
# should print arn:aws:iam::<account>:user/example-sgnl-terraform, not root
```

(If you'd rather install `aws`/`terraform` natively, `aws configure
--profile example-sgnl-terraform` plus `aws_profile = "example-sgnl-terraform"` in
`terraform.tfvars` works the normal way; the wrappers are optional.)

## 4. Point Terraform at it

```bash
cp terraform.tfvars.example terraform.tfvars
# check notification_email, adjust anything else you want to override
./tf init
./tf plan   # review before apply, as always
```

From here on, root is never touched again for anything in this repo.

## Changing the policy later (CloudShell, as root)

Edit `terraform-policy.json` here, commit, render it (as in step 2),
upload the rendered file to CloudShell, then
replace the live version in place (IAM keeps at most 5 versions; delete
an old non-default one first if it complains):

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
aws iam create-policy-version \
  --policy-arn "arn:aws:iam::${ACCOUNT_ID}:policy/example-sgnl-terraform" \
  --policy-document file://terraform-policy.json --set-as-default
```

The Resource ARNs use `{{SGNL_PREFIX}}`, the same prefix `./tf` passes
to Terraform as `name_prefix` (both from `instance/sgnl.env`).

## What this policy does and doesn't allow

Scoped to exactly what `aws/*.tf` provisions — the one S3 bucket
(`example-sgnl-*`), the one Lambda function (`example-sgnl-ses-forwarder`), the one
IAM role it needs (same name, and `iam:PassRole` is conditioned to only
allow passing it to `lambda.amazonaws.com`, not anything else), the one
Secrets Manager path (`example-sgnl/*`), and CloudWatch/SNS resources named
`example-sgnl-*`. **Not** `AdministratorAccess`.

The one broad grant is `ses:*` on `Resource: "*"` — SES's older
receiving/identity APIs (the ones `aws_ses_domain_identity`,
`aws_ses_receipt_rule`, etc. call) largely don't support resource-level
ARN scoping, so there's no tighter form available for those specific
calls. Everything else in this policy is scoped to this project's
resources by name.

This user still can't touch `cotenant`'s infrastructure, other S3 buckets,
other Lambda functions, or anything unrelated in the account.
