# The on-demand fake WhatsApp server (WS-340): created by up.sh, removed by down.sh.
#
#   testserver.stacx24.com ─► EC2 (t4g.nano, Amazon Linux 2023 minimal ARM, 4 GB disk)
#       Caddy  :443  HTTPS + basic auth + static UI (WS-330 U4: reverse proxy)
#       Node   :4020 comdove-fake-backend (not reachable from outside)
#
# Only NEW resources, all tagged Project=comdove-fake-server. The hosted zone
# and default VPC are only read.

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.70, < 8.0"
    }
  }
  # bucket / key / region are passed by scripts/up.sh (-backend-config).
  backend "s3" {}
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project   = "comdove-fake-server"
      ManagedBy = "terraform"
      Stack     = "server"
    }
  }
}

data "aws_caller_identity" "me" {}

data "aws_route53_zone" "main" {
  name = var.zone_name
}

data "aws_vpc" "default" {
  default = true
}

# AWS-published pointer to the latest Amazon Linux 2023 MINIMAL ARM image
# (the standard image needs an 8 GB disk; minimal allows 2 GB+).
data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-minimal-kernel-default-arm64"
}

locals {
  domain       = "${var.subdomain}.${var.zone_name}"
  param_prefix = "/comdove-fake"
  account_id   = data.aws_caller_identity.me.account_id
}

# ---- the build (made on the laptop by scripts/build.sh) ---------------------

resource "aws_s3_object" "build" {
  bucket = var.bucket_name
  # Content hash in the key: a new build → new key → new user_data → fresh server.
  key    = "builds/comdove-fake-${filemd5(var.build_zip)}.zip"
  source = var.build_zip
  etag   = filemd5(var.build_zip)
}

# ---- network ----------------------------------------------------------------

resource "aws_security_group" "server" {
  name        = "comdove-fake-server"
  description = "comdove fake WhatsApp server: HTTP(S) only, no SSH"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description      = "HTTP (redirects to HTTPS, ACME challenge)"
    from_port        = 80
    to_port          = 80
    protocol         = "tcp"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  ingress {
    description      = "HTTPS"
    from_port        = 443
    to_port          = 443
    protocol         = "tcp"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  egress {
    description      = "all outbound (packages, ComDove webhooks, S3, SSM)"
    from_port        = 0
    to_port          = 0
    protocol         = "-1"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }
}

# ---- permissions for the instance -------------------------------------------

resource "aws_iam_role" "server" {
  name = "comdove-fake-server"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# Shell access through AWS Systems Manager (no SSH port, no key pair).
resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.server.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "server" {
  name = "comdove-fake-server"
  role = aws_iam_role.server.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadOwnSecrets"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:GetParameters"]
        Resource = "arn:aws:ssm:${var.region}:${local.account_id}:parameter${local.param_prefix}/*"
      },
      {
        Sid       = "DecryptSecureStrings"
        Effect    = "Allow"
        Action    = "kms:Decrypt"
        Resource  = "*"
        Condition = { StringEquals = { "kms:ViaService" = "ssm.${var.region}.amazonaws.com" } }
      },
      {
        Sid      = "ReadBuild"
        Effect   = "Allow"
        Action   = "s3:GetObject"
        Resource = "arn:aws:s3:::${var.bucket_name}/builds/*"
      },
      {
        Sid      = "RuntimeBackups"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = "arn:aws:s3:::${var.bucket_name}/runtime/*"
      },
      {
        # Each boot the instance gets a new public IP and points ONLY its own
        # A record at it (a stopped instance releases its IP).
        Sid      = "UpdateOwnDnsRecord"
        Effect   = "Allow"
        Action   = "route53:ChangeResourceRecordSets"
        Resource = data.aws_route53_zone.main.arn
        Condition = {
          "ForAllValues:StringEquals" = {
            "route53:ChangeResourceRecordSetsNormalizedRecordNames" = [local.domain]
            "route53:ChangeResourceRecordSetsRecordTypes"           = ["A"]
            "route53:ChangeResourceRecordSetsActions"               = ["UPSERT"]
          }
        }
      },
      {
        Sid      = "ReadDnsChangeStatus"
        Effect   = "Allow"
        Action   = "route53:GetChange"
        Resource = "arn:aws:route53:::change/*"
      },
      {
        Sid       = "ListRuntime"
        Effect    = "Allow"
        Action    = "s3:ListBucket"
        Resource  = "arn:aws:s3:::${var.bucket_name}"
        Condition = { StringLike = { "s3:prefix" = ["runtime/*"] } }
      },
    ]
  })
}

resource "aws_iam_instance_profile" "server" {
  name = "comdove-fake-server"
  role = aws_iam_role.server.name
}

# ---- the server ---------------------------------------------------------------

resource "aws_instance" "server" {
  ami                         = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type               = var.instance_type
  vpc_security_group_ids      = [aws_security_group.server.id]
  associate_public_ip_address = true # no Elastic IP: it would cost more than the server
  iam_instance_profile        = aws_iam_instance_profile.server.name

  # Power-off (idle watchdog or the /power toggle) → EC2 "stop": no instance or
  # IP charges while stopped, disk + data kept, restart in ~1 min (start.sh).
  instance_initiated_shutdown_behavior = "stop"

  # "standard" = no surprise charges for CPU bursts beyond the free credits.
  credit_specification {
    cpu_credits = "standard"
  }

  metadata_options {
    http_tokens = "required" # IMDSv2 only
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_gb
    encrypted             = true
    delete_on_termination = true
  }

  user_data = templatefile("${path.module}/user_data.sh.tftpl", {
    region       = var.region
    bucket       = var.bucket_name
    build_key    = aws_s3_object.build.key
    param_prefix = local.param_prefix
    domain       = local.domain
    zone_id      = data.aws_route53_zone.main.zone_id
    idle_minutes = var.idle_minutes
    acme_email   = var.acme_email
    persist_data = var.persist_data
  })
  user_data_replace_on_change = true

  tags = {
    Name = "comdove-fake-server"
  }

  depends_on = [aws_iam_role_policy.server, aws_iam_role_policy_attachment.ssm_core]
}

# ---- DNS ------------------------------------------------------------------------

resource "aws_route53_record" "server" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = local.domain
  type    = "A"
  ttl     = 60 # a new server gets a new IP; keep caches short
  records = [aws_instance.server.public_ip]

  # After a stop/start the instance re-points this record itself (new IP).
  lifecycle {
    ignore_changes = [records]
  }
}
