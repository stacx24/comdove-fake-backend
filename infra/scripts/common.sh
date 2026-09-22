#!/usr/bin/env bash
# Shared settings + helpers for the infra scripts (sourced, not run).
set -euo pipefail

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$INFRA_DIR/.." && pwd)"
REGION="${AWS_REGION:-ap-south-1}"
BUILD_DIR="$INFRA_DIR/.build"
BUILD_ZIP="$BUILD_DIR/comdove-fake.zip"
STATE_KEY="comdove-fake/server.tfstate"
PARAM_PREFIX="/comdove-fake"
REQUIRED_PARAMS=(APP_SECRET WEBHOOK_VERIFY_TOKEN COMDOVE_WEBHOOK_URL UI_USER UI_PASSWORD)

say() { printf '\033[1;36m▶ %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "'$1' is not installed (see infra/README.md → Prerequisites)."; }

# Terraform reads plain AWS_* env vars; export the `aws login` session into them.
ensure_aws() {
  need aws
  need terraform
  if [ -z "${AWS_ACCESS_KEY_ID:-}" ]; then
    eval "$(aws configure export-credentials --format env 2>/dev/null)" \
      || die "No AWS session. Run: aws login --region $REGION"
  fi
  export AWS_REGION="$REGION"
  aws sts get-caller-identity --query Arn --output text >/dev/null 2>&1 \
    || die "AWS session expired. Run: aws login --region $REGION"
}

account_id() { aws sts get-caller-identity --query Account --output text; }

bucket_name() { echo "comdove-fake-server-$(account_id)-$REGION"; }

require_bucket() {
  aws s3api head-bucket --bucket "$1" >/dev/null 2>&1 \
    || die "Bucket $1 not found. Run once: infra/scripts/bootstrap.sh"
}

require_params() {
  local names=() p missing
  for p in "${REQUIRED_PARAMS[@]}"; do names+=("$PARAM_PREFIX/$p"); done
  missing=$(aws ssm get-parameters --names "${names[@]}" --query 'InvalidParameters' --output text)
  [ -z "$missing" ] || [ "$missing" = "None" ] || die "Missing secrets: $missing — run infra/scripts/secrets.sh"
}

# The server instance (any state except terminated), by its tags.
instance_id() {
  aws ec2 describe-instances \
    --filters "Name=tag:Project,Values=comdove-fake-server" "Name=tag:Name,Values=comdove-fake-server" \
              "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[].Instances[].InstanceId' --output text | awk '{print $1}'
}

instance_state() { aws ec2 describe-instances --instance-ids "$1" --query 'Reservations[0].Instances[0].State.Name' --output text; }
instance_ip() { aws ec2 describe-instances --instance-ids "$1" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text; }

# Start a stopped instance and wait until https://<domain>/health answers on its NEW IP.
start_and_wait() { # instance-id domain
  local id=$1 host=$2 state ip ok=0
  state=$(instance_state "$id")
  if [ "$state" = "stopping" ]; then say "Waiting for it to finish stopping"; aws ec2 wait instance-stopped --instance-ids "$id"; state=stopped; fi
  if [ "$state" = "stopped" ]; then say "Starting $id"; aws ec2 start-instances --instance-ids "$id" >/dev/null; fi
  aws ec2 wait instance-running --instance-ids "$id"
  ip=$(instance_ip "$id")
  say "Running at $ip — waiting for https://$host (boot ~30–60 s; first ever boot 3–5 min)"
  for _ in $(seq 1 60); do
    if curl -fsS --max-time 5 --resolve "$host:443:$ip" "https://$host/health" >/dev/null 2>&1; then ok=1; break; fi
    printf '.'; sleep 10
  done
  echo
  [ "$ok" = 1 ] || die "Not healthy after 10 min. Shell: aws ssm start-session --target $id → sudo tail -100 /var/log/comdove-fake-setup.log"
  START_IP=$ip
}

server_init() {
  terraform -chdir="$INFRA_DIR/server" init -input=false -reconfigure \
    -backend-config="bucket=$1" \
    -backend-config="key=$STATE_KEY" \
    -backend-config="region=$REGION" \
    -backend-config="encrypt=true" \
    -backend-config="use_lockfile=true" >/dev/null
}
