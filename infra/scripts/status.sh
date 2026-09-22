#!/usr/bin/env bash
# Is the fake server running? Shows the instance state and the health check.
source "$(dirname "$0")/common.sh"
ensure_aws

say "Instances tagged Project=comdove-fake-server"
aws ec2 describe-instances \
  --filters "Name=tag:Project,Values=comdove-fake-server" "Name=instance-state-name,Values=pending,running,stopping,stopped,shutting-down" \
  --query 'Reservations[].Instances[].[InstanceId,State.Name,InstanceType,PublicIpAddress,LaunchTime]' \
  --output table

DOMAIN="testserver.stacx24.com"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "https://$DOMAIN/health" || true)
echo "https://$DOMAIN/health → HTTP ${code:-000}  (200 = up)"
