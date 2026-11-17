data "archive_file" "forwarder" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/forwarder"
  output_path = "${path.module}/lambda/forwarder.zip"
  excludes    = ["node_modules/.cache", "*.zip"]
}

# Terraform only creates the container - it deliberately never writes a
# value here, so the password never touches Terraform state. Set it
# manually after `apply`; see ../docs/DEPLOY.md.
resource "aws_secretsmanager_secret" "relay_password" {
  name        = "${var.name_prefix}/ses-relay-smtp-password"
  description = "Password for the dedicated Stalwart relay account (var.relay_username) this Lambda authenticates as."
}

resource "aws_iam_role" "forwarder" {
  name = "${var.name_prefix}-ses-forwarder"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "forwarder" {
  name = "${var.name_prefix}-ses-forwarder"
  role = aws_iam_role.forwarder.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadInboundMessages"
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.inbound.arn}/incoming/*"
      },
      {
        Sid      = "ReadRelayPassword"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = aws_secretsmanager_secret.relay_password.arn
      },
      {
        Sid      = "SendFailedEventsToDLQ"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = aws_sqs_queue.forwarder_dlq.arn
      },
      {
        Sid      = "WriteOwnLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:*:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${var.name_prefix}-ses-forwarder*"
      }
    ]
  })
}

resource "aws_lambda_function" "forwarder" {
  function_name    = "${var.name_prefix}-ses-forwarder"
  role             = aws_iam_role.forwarder.arn
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  timeout          = 30
  filename         = data.archive_file.forwarder.output_path
  source_code_hash = data.archive_file.forwarder.output_base64sha256

  environment {
    variables = {
      INBOUND_BUCKET   = aws_s3_bucket.inbound.id
      INBOUND_PREFIX   = "incoming/"
      STALWART_HOST    = var.stalwart_host
      STALWART_PORT    = tostring(var.stalwart_submission_port)
      RELAY_USERNAME   = var.relay_username
      RELAY_SECRET_ARN = aws_secretsmanager_secret.relay_password.arn
    }
  }
}

# Async invocations (SES uses invocation_type = "Event") are retried twice
# by Lambda, then dropped. Without an on-failure destination a message
# that exhausts its retries is still in S3 but nothing points at it
# anymore. The DLQ keeps the original SES event (requestPayload) plus the
# error, so it can be replayed - see README.md "Replaying failed messages".
resource "aws_sqs_queue" "forwarder_dlq" {
  name                      = "${var.name_prefix}-ses-forwarder-dlq"
  message_retention_seconds = 1209600 # 14 days, the SQS maximum
}

resource "aws_lambda_function_event_invoke_config" "forwarder" {
  function_name                = aws_lambda_function.forwarder.function_name
  maximum_retry_attempts       = 2
  maximum_event_age_in_seconds = 21600 # 6h, the Lambda maximum

  destination_config {
    on_failure {
      destination = aws_sqs_queue.forwarder_dlq.arn
    }
  }
}

resource "aws_lambda_permission" "allow_ses" {
  statement_id   = "AllowSESInvoke"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.forwarder.function_name
  principal      = "ses.amazonaws.com"
  source_account = data.aws_caller_identity.current.account_id
}
