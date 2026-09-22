# One-time, long-lived bucket for the fake-server stack (WS-340).
#
# Holds: Terraform state of infra/server, the uploaded build, and runtime
# backups (Caddy's TLS certificates + the mock's SQLite file) so that
# `down` + `up` does not re-issue a certificate every time (Let's Encrypt
# allows only 5 per week for the same name) and keeps test data.
#
# Apply ONCE with ./infra/scripts/bootstrap.sh. Never destroyed by down.sh.

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.70, < 8.0"
    }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project   = "comdove-fake-server"
      ManagedBy = "terraform"
      Stack     = "bootstrap"
    }
  }
}

data "aws_caller_identity" "me" {}

locals {
  bucket_name = "comdove-fake-server-${data.aws_caller_identity.me.account_id}-${var.region}"
}

resource "aws_s3_bucket" "this" {
  bucket = local.bucket_name
}

resource "aws_s3_bucket_ownership_controls" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "this" {
  bucket                  = aws_s3_bucket.this.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Versioning protects the Terraform state file from accidental overwrite.
resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id
  versioning_configuration {
    status = "Enabled"
  }
}

# Keep the bucket tiny: old builds and old object versions expire.
resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket     = aws_s3_bucket.this.id
  depends_on = [aws_s3_bucket_versioning.this]

  rule {
    id     = "expire-old-builds"
    status = "Enabled"
    filter {
      prefix = "builds/"
    }
    expiration {
      days = 14
    }
  }

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}
