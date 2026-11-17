terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}

# Credentials come from the standard AWS provider chain. With ./tf that's
# AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, read from the Keychain by
# .docker-aws-env - nothing AWS-specific is hardcoded here.

provider "aws" {
  region  = var.region
  profile = var.aws_profile
}

data "aws_caller_identity" "current" {}
