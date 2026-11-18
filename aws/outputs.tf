output "mx_target" {
  description = "Paste into docs/DNS.md's MX record, priority 10."
  value       = "inbound-smtp.${var.region}.amazonaws.com"
}

output "relay_secret_arn" {
  description = "Set this secret's value after apply - see docs/DEPLOY.md. Terraform never writes the value itself."
  value       = aws_secretsmanager_secret.relay_password.arn
}

output "inbound_bucket_name" {
  value = aws_s3_bucket.inbound.id
}

output "forwarder_function_name" {
  value = aws_lambda_function.forwarder.function_name
}

output "forwarder_dlq_url" {
  description = "SQS queue holding SES events the forwarder gave up on - see README.md \"Replaying failed messages\"."
  value       = aws_sqs_queue.forwarder_dlq.url
}

output "newsletter_configuration_set" {
  description = "SES configuration set listmonk's mail carries (X-SES-CONFIGURATION-SET)."
  value       = aws_sesv2_configuration_set.newsletter.configuration_set_name
}

output "newsletter_events_topic_arn" {
  description = "SNS topic with newsletter bounces/complaints; allowed in listmonk's bounce settings."
  value       = aws_sns_topic.newsletter_events.arn
}
