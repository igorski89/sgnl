# --- The SES domain identity, never destroyed ----------------------------
# All company mail sends as this domain (and Gmail's "send mail as" may
# use it too). prevent_destroy: Terraform refuses any plan that would
# delete it, a `terraform destroy` of this folder included.
#
# Fresh instance: `./tf apply` creates it with Easy DKIM; add the three
# DKIM CNAMEs and the MAIL FROM records it reports (docs/DNS.md).
# Identity made by hand before (the console): adopt it instead, with no
# change in AWS:
#   ./tf import aws_sesv2_email_identity.domain <domain>
#   ./tf import aws_sesv2_email_identity_mail_from_attributes.domain <domain>
#   ./tf import aws_sesv2_email_identity_feedback_attributes.domain <domain>
# then `./tf plan` must show no changes.

resource "aws_sesv2_email_identity" "domain" {
  email_identity = var.domain_name

  lifecycle {
    prevent_destroy = true
  }
}

# Bounces from mail servers come back to this domain's own MAIL FROM.
resource "aws_sesv2_email_identity_mail_from_attributes" "domain" {
  email_identity         = aws_sesv2_email_identity.domain.email_identity
  mail_from_domain       = "mail.${var.domain_name}"
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}

# Bounce and complaint feedback for company mail: forwarded by email to
# the sender (no SNS). Campaign mail has its own route (campaigns.tf).
resource "aws_sesv2_email_identity_feedback_attributes" "domain" {
  email_identity           = aws_sesv2_email_identity.domain.email_identity
  email_forwarding_enabled = true
}
