variable "aws_profile" {
  description = "Named AWS CLI profile, only if you run a native terraform with ~/.aws instead of ./tf. Leave null with ./tf: it injects the <prefix>-terraform key from bin/sgnl-secret as env vars (see .docker-aws-env)."
  type        = string
  default     = null
}

variable "domain_name" {
  description = "The domain SES sends/receives for."
  type        = string
}

variable "region" {
  description = "SES region for both directions. Outbound: must match the region of AWS_SES_SMTP_USERNAME/PASSWORD and email-smtp.<region>.amazonaws.com in ../stalwart/plan.ndjson. Inbound: the domain identity must be verified here (it is, see ses.tf) and the region must support SES receiving (eu-central-1 does, checked 2026-10-08)."
  type        = string
  default     = "eu-central-1"
}

variable "inbound_bucket_name" {
  description = "S3 bucket SES writes raw inbound messages to before Lambda relays them into Stalwart. Must be globally unique."
  type        = string
}

variable "inbound_retention_days" {
  description = "How long raw messages stay in S3 after Stalwart already has them. This is an audit trail / durability buffer, not primary mail storage."
  type        = number
  default     = 30
}

variable "stalwart_host" {
  description = "Where the forwarder Lambda relays into. Matches the `proxy.host` in ../config/deploy.stalwart.yml."
  type        = string
}

variable "stalwart_submission_port" {
  description = "Stalwart's implicit-TLS submission port (config/deploy.stalwart.yml publishes 465)."
  type        = number
  default     = 465
}

variable "relay_username" {
  description = "Dedicated Stalwart account the Lambda authenticates as - NOT a real user's personal login. Create this account manually in Stalwart's admin UI; see ../docs/DEPLOY.md."
  type        = string
}

variable "notification_email" {
  description = "Subscribed to the CloudWatch alarm SNS topic - gets notified if the forwarder Lambda starts failing. Raw messages stay safe in S3 either way, but you still want to know."
  type        = string
}

variable "name_prefix" {
  description = "Prefix for every AWS resource name here (<company>-<project>). Set by ./tf from SGNL_PREFIX in instance/sgnl.env, like the other instance values here (domain_name, stalwart_host, relay_username, inbound_bucket_name, notification_email). bootstrap/terraform-policy.json uses the same prefix ({{SGNL_PREFIX}}, rendered with bin/sgnl-render)."
  type        = string
}

variable "listmonk_host" {
  description = "listmonk's host; SES bounce/complaint events for newsletters go to https://<this>/webhooks/service/ses. Set by ./tf from SGNL_APPS_DOMAIN."
  type        = string
}
