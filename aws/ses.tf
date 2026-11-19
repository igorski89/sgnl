# --- Domain identity: see ses-identity.tf ------------------------------------
# Protected by prevent_destroy, so a `destroy` here can never take it down.
# Receiving needs the domain verified in this region, which it is.

# --- Receiving: rule set + rule ---------------------------------------------
# Only one receipt rule set can be active per region; there was none in
# eu-central-1 before this (checked 2026-10-08).

resource "aws_ses_receipt_rule_set" "sgnl" {
  rule_set_name = "${var.name_prefix}-inbound"
}

resource "aws_ses_active_receipt_rule_set" "sgnl" {
  rule_set_name = aws_ses_receipt_rule_set.sgnl.rule_set_name
}

resource "aws_ses_receipt_rule" "forward_to_stalwart" {
  name          = "forward-to-stalwart"
  rule_set_name = aws_ses_receipt_rule_set.sgnl.rule_set_name
  recipients    = [var.domain_name]
  enabled       = true
  scan_enabled  = true # SES's own spam/virus scan runs before the actions below

  s3_action {
    bucket_name       = aws_s3_bucket.inbound.id
    object_key_prefix = "incoming/"
    position          = 1
  }

  lambda_action {
    function_arn    = aws_lambda_function.forwarder.arn
    invocation_type = "Event" # async - SES doesn't wait on Lambda before accepting the SMTP session
    position        = 2
  }

  depends_on = [aws_lambda_permission.allow_ses]
}
