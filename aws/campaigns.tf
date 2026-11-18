# --- Campaigns (listmonk): bounce and complaint feedback -------------------
# listmonk sends through SES SMTP with the header
# X-SES-CONFIGURATION-SET: <prefix>-campaigns (bin/sgnl-listmonk-setup).
# Only those messages publish their bounces and complaints to this topic,
# which listmonk subscribes to; it blocklists hard bounces and complaints.
# The domain identity (and so all other company mail) is untouched.

resource "aws_sesv2_configuration_set" "campaigns" {
  configuration_set_name = "${var.name_prefix}-campaigns"

  # AWS reports default delivery options (max_delivery_seconds = 0) that
  # the provider would "remove" on every plan; we don't manage them.
  lifecycle {
    ignore_changes = [delivery_options]
  }
}

resource "aws_sns_topic" "campaigns_events" {
  name = "${var.name_prefix}-campaigns-events"
}

resource "aws_sns_topic_policy" "campaigns_events" {
  arn = aws_sns_topic.campaigns_events.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "SESPublish"
      Effect    = "Allow"
      Principal = { Service = "ses.amazonaws.com" }
      Action    = "sns:Publish"
      Resource  = aws_sns_topic.campaigns_events.arn
      Condition = {
        StringEquals = { "AWS:SourceAccount" = data.aws_caller_identity.current.account_id }
      }
    }]
  })
}

resource "aws_sesv2_configuration_set_event_destination" "campaigns_bounces" {
  configuration_set_name = aws_sesv2_configuration_set.campaigns.configuration_set_name
  event_destination_name = "listmonk-bounces"
  event_destination {
    enabled              = true
    matching_event_types = ["BOUNCE", "COMPLAINT"]
    sns_destination {
      topic_arn = aws_sns_topic.campaigns_events.arn
    }
  }
  depends_on = [aws_sns_topic_policy.campaigns_events]
}

# listmonk confirms the subscription itself once its bounce settings
# allow this topic (bin/sgnl-listmonk-setup runs first).
resource "aws_sns_topic_subscription" "campaigns_listmonk" {
  topic_arn              = aws_sns_topic.campaigns_events.arn
  protocol               = "https"
  endpoint               = "https://${var.listmonk_host}/webhooks/service/ses"
  endpoint_auto_confirms = true
  raw_message_delivery   = false
}
