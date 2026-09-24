#!/usr/bin/env bash
# ONE-TIME: create the private S3 bucket (Terraform state, builds, backups).
source "$(dirname "$0")/common.sh"
ensure_aws

say "Creating the long-lived bucket in $REGION (review the plan, then type yes)"
terraform -chdir="$INFRA_DIR/bootstrap" init -input=false >/dev/null
terraform -chdir="$INFRA_DIR/bootstrap" apply -var "region=$REGION"
say "Bucket: $(terraform -chdir="$INFRA_DIR/bootstrap" output -raw bucket_name)"
echo "Next: infra/scripts/secrets.sh"
