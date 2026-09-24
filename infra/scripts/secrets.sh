#!/usr/bin/env bash
# Store the server's secrets in AWS Parameter Store (/comdove-fake/*).
# They never touch the repo or Terraform state. Press Enter to keep a value
# that is already stored. Input is hidden.
source "$(dirname "$0")/common.sh"
ensure_aws

exists() { aws ssm get-parameter --name "$PARAM_PREFIX/$1" >/dev/null 2>&1; }

ask() { # name type hidden(1/0) prompt
  local name=$1 type=$2 hidden=$3 prompt=$4 value
  if exists "$name"; then prompt="$prompt [stored — Enter keeps it]"; fi
  if [ "$hidden" = 1 ]; then read -rsp "$prompt: " value; echo; else read -rp "$prompt: " value; fi
  if [ -z "$value" ]; then
    exists "$name" && { echo "  = kept $PARAM_PREFIX/$name"; return; }
    die "$name is required"
  fi
  aws ssm put-parameter --name "$PARAM_PREFIX/$name" --type "$type" --value "$value" --overwrite >/dev/null
  echo "  ✓ saved $PARAM_PREFIX/$name"
}

say "Secrets for the fake server (see infra/README.md → Secrets)"
ask APP_SECRET            SecureString 1 "APP_SECRET (must equal ComDove's META_APP_SECRET)"
ask WEBHOOK_VERIFY_TOKEN  SecureString 1 "WEBHOOK_VERIFY_TOKEN (must equal ComDove's WHATSAPP_VERIFY_TOKEN)"
ask COMDOVE_WEBHOOK_URL   String       0 "COMDOVE_WEBHOOK_URL (public ComDove URL + /webhooks/whatsapp)"
ask UI_USER               String       0 "UI_USER (login name for the fake UI/API)"
ask UI_PASSWORD           SecureString 1 "UI_PASSWORD (login password for the fake UI/API)"
echo "Next: infra/scripts/up.sh"
