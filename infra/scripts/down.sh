#!/usr/bin/env bash
# Tear the fake server down (instance, security group, IAM role, DNS record).
# The bucket (state, certificate, data backup) is kept — it costs cents.
#   infra/scripts/down.sh      review, type yes
#   infra/scripts/down.sh -y   no prompt
source "$(dirname "$0")/common.sh"
AUTO=""
[ "${1:-}" = "-y" ] && AUTO="-auto-approve"
ensure_aws

BUCKET=$(bucket_name)
require_bucket "$BUCKET"

# destroy still evaluates filemd5(build_zip); an empty placeholder is enough.
ZIP="$BUILD_ZIP"
if [ ! -f "$ZIP" ]; then
  mkdir -p "$BUILD_DIR"
  ZIP="$BUILD_DIR/placeholder.zip"
  : > "$ZIP"
fi

say "terraform destroy (server stack only; a final data/certificate backup runs as the server shuts down)"
server_init "$BUCKET"
terraform -chdir="$INFRA_DIR/server" destroy -input=false $AUTO \
  -var "region=$REGION" -var "bucket_name=$BUCKET" -var "build_zip=$ZIP"
say "DOWN — nothing is running. Bucket $BUCKET kept."
