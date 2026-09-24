#!/usr/bin/env bash
# Start the (stopped) fake server — ~1 minute. Data and certificate are kept.
# If it was never created or was destroyed, use up.sh instead.
source "$(dirname "$0")/common.sh"
ensure_aws
need curl
ID=$(instance_id)
[ -n "$ID" ] || die "No server exists. Create it with: infra/scripts/up.sh"
start_and_wait "$ID" "testserver.stacx24.com"
say "ON: https://testserver.stacx24.com  (power page: /power)"
