# --- The SES domain identity: adopted, never destroyed ----------------------
# Verified by hand in eu-central-1 before this project (Easy DKIM, custom
# MAIL FROM mail.<domain>, production access); all company mail and
# Gmail's "send mail as" depend on it. Imported 2026-11-18 so its settings
# are reviewed and versioned here; the import changed nothing in AWS.
# prevent_destroy: Terraform refuses any plan that would delete it, a
# `terraform destroy` of this folder included. To stop managing it without
# touching AWS: terraform state rm these three, then delete this file.

import {
  to = aws_sesv2_email_identity.domain
  id = var.domain_name
}

import {
  to = aws_sesv2_email_identity_mail_from_attributes.domain
  id = var.domain_name
}

import {
  to = aws_sesv2_email_identity_feedback_attributes.domain
  id = var.domain_name
}

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
