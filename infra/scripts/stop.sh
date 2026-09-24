#!/usr/bin/env bash
# Stop the fake server now (EC2 stop: no instance/IP charges; disk + data kept).
#   infra/scripts/stop.sh      asks for confirmation
#   infra/scripts/stop.sh -y   no prompt
source "$(dirname "$0")/common.sh"
ensure_aws
ID=$(instance_id)
[ -n "$ID" ] || die "No server exists."
[ "$(instance_state "$ID")" = "stopped" ] && { say "Already stopped."; exit 0; }
if [ "${1:-}" != "-y" ]; then
  read -rp "Turn the fake server OFF now? Everyone using it is disconnected. [y/N] " a
  [[ "$a" =~ ^[Yy]$ ]] || { echo "Cancelled."; exit 0; }
fi
aws ec2 stop-instances --instance-ids "$ID" >/dev/null
say "Stopping $ID (final data backup runs during shutdown)…"
aws ec2 wait instance-stopped --instance-ids "$ID"
say "OFF. Start again with: infra/scripts/start.sh"
