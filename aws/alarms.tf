# The one thing that makes the S3-durability guarantee actually useful:
# if you never find out the forwarder is stuck, messages just accumulate
# unread in S3 forever. This is what turns "durable" into "durable AND
# you'll notice."

resource "aws_sns_topic" "forwarder_alerts" {
  name = "${var.name_prefix}-ses-forwarder-alerts"
}

resource "aws_sns_topic_subscription" "forwarder_alerts_email" {
  topic_arn = aws_sns_topic.forwarder_alerts.arn
  protocol  = "email"
  endpoint  = var.notification_email
}

resource "aws_cloudwatch_metric_alarm" "forwarder_errors" {
  alarm_name          = "${var.name_prefix}-ses-forwarder-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_description   = "${var.name_prefix}-ses-forwarder is failing - raw messages are still safe in S3 (see inbound_bucket_name), but they are not reaching Stalwart. Check: aws logs tail /aws/lambda/${var.name_prefix}-ses-forwarder --follow"
  dimensions = {
    FunctionName = aws_lambda_function.forwarder.function_name
  }
  alarm_actions = [aws_sns_topic.forwarder_alerts.arn]
}

# The Errors alarm above fires on every failed attempt, including ones a
# retry later fixes. This one fires only when a message has given up for
# good and is waiting in the DLQ to be replayed by hand.
resource "aws_cloudwatch_metric_alarm" "forwarder_dlq" {
  alarm_name          = "${var.name_prefix}-ses-forwarder-dlq"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_description   = "Inbound messages exhausted all forwarder retries and are parked in ${var.name_prefix}-ses-forwarder-dlq. Raw messages are still in S3 - fix Stalwart, then replay per aws/README.md."
  dimensions = {
    QueueName = aws_sqs_queue.forwarder_dlq.name
  }
  alarm_actions = [aws_sns_topic.forwarder_alerts.arn]
}
