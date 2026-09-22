variable "region" {
  description = "AWS region."
  type        = string
  default     = "ap-south-1"
}

variable "bucket_name" {
  description = "Bucket created by infra/bootstrap (state, builds, runtime backups). Passed by up.sh."
  type        = string
}

variable "build_zip" {
  description = "Local path of the build made by scripts/build.sh. Passed by up.sh."
  type        = string
}

variable "zone_name" {
  description = "Existing Route 53 hosted zone (only read, never changed)."
  type        = string
  default     = "stacx24.com"
}

variable "subdomain" {
  description = "Host name inside the zone → testserver.stacx24.com."
  type        = string
  default     = "testserver"
}

variable "instance_type" {
  description = "Smallest ARM instance; the server needs ~200 MB RAM."
  type        = string
  default     = "t4g.nano"
}

variable "idle_minutes" {
  description = "Power off (→ EC2 stop) after this many minutes with no HTTPS traffic and no open browser connection. 0 = never."
  type        = number
  default     = 5

  validation {
    condition     = var.idle_minutes == 0 || var.idle_minutes >= 3
    error_message = "idle_minutes must be 0 (off) or at least 3."
  }
}

variable "root_volume_gb" {
  description = "Root disk size (GB). The minimal image needs at least 2; 4 leaves room for tools + a 1 GB swap file."
  type        = number
  default     = 4

  validation {
    condition     = var.root_volume_gb >= 4
    error_message = "root_volume_gb must be at least 4 (OS + tools + swap)."
  }
}

variable "acme_email" {
  description = "Optional contact email for the TLS certificate account (Let's Encrypt/ZeroSSL). Empty = none."
  type        = string
  default     = ""
}

variable "persist_data" {
  description = "Back up the mock's SQLite data to S3 and restore it on the next up."
  type        = bool
  default     = true
}
