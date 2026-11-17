resource "aws_s3_bucket" "inbound" {
  bucket = var.inbound_bucket_name
}

resource "aws_s3_bucket_public_access_block" "inbound" {
  bucket                  = aws_s3_bucket.inbound.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "inbound" {
  bucket = aws_s3_bucket.inbound.id
  rule {
    id     = "expire-after-relay"
    status = "Enabled"
    filter {}
    expiration {
      days = var.inbound_retention_days
    }
  }
}

# Lets SES - and only SES, and only rules belonging to this account -
# write the raw message here before Lambda ever runs. This write
# happening first, independent of whether Lambda/Stalwart are healthy,
# is what makes inbound mail durable even through an outage.
resource "aws_s3_bucket_policy" "inbound" {
  bucket = aws_s3_bucket.inbound.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowSESPuts"
        Effect    = "Allow"
        Principal = { Service = "ses.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.inbound.arn}/*"
        Condition = {
          StringEquals = {
            "aws:Referer"       = data.aws_caller_identity.current.account_id
            "aws:SourceAccount" = data.aws_caller_identity.current.account_id
          }
        }
      }
    ]
  })
}
