# --- Newsletters (listmonk): bounce and complaint feedback -------------------
# listmonk sends through SES SMTP with the header
# X-SES-CONFIGURATION-SET: <prefix>-newsletter (bin/sgnl-listmonk-setup).
# Only those messages publish their bounces and complaints to this topic,
# which listmonk subscribes to; it blocklists hard bounces and complaints.
# The domain identity (and so all other company mail) is untouched.

resource "aws_sesv2_configuration_set" "newsletter" {
  configuration_set_name = "${var.name_prefix}-newsletter"
}

resource "aws_sns_topic" "newsletter_events" {
  name = "${var.name_prefix}-newsletter-events"
}

resource "aws_sns_topic_policy" "newsletter_events" {
  arn = aws_sns_topic.newsletter_events.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "SESPublish"
      Effect    = "Allow"
      Principal = { Service = "ses.amazonaws.com" }
      Action    = "sns:Publish"
      Resource  = aws_sns_topic.newsletter_events.arn
      Condition = {
        StringEquals = { "AWS:SourceAccount" = data.aws_caller_identity.current.account_id }
      }
    }]
  })
}

resource "aws_sesv2_configuration_set_event_destination" "newsletter_bounces" {
  configuration_set_name = aws_sesv2_configuration_set.newsletter.configuration_set_name
  event_destination_name = "listmonk-bounces"
  event_destination {
    enabled              = true
    matching_event_types = ["BOUNCE", "COMPLAINT"]
    sns_destination {
      topic_arn = aws_sns_topic.newsletter_events.arn
    }
  }
  depends_on = [aws_sns_topic_policy.newsletter_events]
}

# listmonk confirms the subscription itself once its bounce settings
# allow this topic (bin/sgnl-listmonk-setup runs first).
resource "aws_sns_topic_subscription" "newsletter_listmonk" {
  topic_arn              = aws_sns_topic.newsletter_events.arn
  protocol               = "https"
  endpoint               = "https://${var.listmonk_host}/webhooks/service/ses"
  endpoint_auto_confirms = true
  raw_message_delivery   = false
}
