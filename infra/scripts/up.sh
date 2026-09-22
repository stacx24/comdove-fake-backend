#!/usr/bin/env bash
# Bring the fake server up: build → terraform apply → wait until healthy → seed.
#   infra/scripts/up.sh            review the plan, type yes
#   infra/scripts/up.sh -y         no prompt
#   SKIP_BUILD=1 infra/scripts/up.sh   reuse the last build
source "$(dirname "$0")/common.sh"
AUTO=""
[ "${1:-}" = "-y" ] && AUTO="-auto-approve"
ensure_aws
need curl
need python3

BUCKET=$(bucket_name)
require_bucket "$BUCKET"
require_params

if [ "${SKIP_BUILD:-0}" = 1 ] && [ -f "$BUILD_ZIP" ]; then
  say "Reusing $BUILD_ZIP"
else
  "$INFRA_DIR/scripts/build.sh"
fi

say "terraform apply (server stack)"
server_init "$BUCKET"
terraform -chdir="$INFRA_DIR/server" apply -input=false $AUTO \
  -var "region=$REGION" -var "bucket_name=$BUCKET" -var "build_zip=$BUILD_ZIP"

URL=$(terraform -chdir="$INFRA_DIR/server" output -raw url)
HOST=${URL#https://}
ID=$(terraform -chdir="$INFRA_DIR/server" output -raw instance_id)

# Starts it if it was stopped (idle / power toggle), then waits on its current IP
# (pinned, so a stale DNS cache on this laptop can't fool the check).
start_and_wait "$ID" "$HOST"
IP=$START_IP

# Optional: register the team's standard numbers + groups (infra/seed.json).
SEED="$INFRA_DIR/seed.json"
if [ -f "$SEED" ]; then
  say "Seeding from infra/seed.json (existing entries are skipped)"
  export SEED URL HOST IP
  export UI_USER="$(aws ssm get-parameter --name "$PARAM_PREFIX/UI_USER" --query Parameter.Value --output text)"
  export UI_PASSWORD="$(aws ssm get-parameter --name "$PARAM_PREFIX/UI_PASSWORD" --with-decryption --query Parameter.Value --output text)"
  python3 - <<'PY'
import base64, json, os, ssl, socket, urllib.request, urllib.error
seed = json.load(open(os.environ["SEED"]))
auth = base64.b64encode(f'{os.environ["UI_USER"]}:{os.environ["UI_PASSWORD"]}'.encode()).decode()
host, ip, url = os.environ["HOST"], os.environ["IP"], os.environ["URL"]
_orig = socket.getaddrinfo
socket.getaddrinfo = lambda h, *a, **k: _orig(ip if h == host else h, *a, **k)  # same pin as curl --resolve
import time
def post(path, body):
    # Retries: right after first boot the tiny instance can still be busy.
    for attempt in range(1, 5):
        req = urllib.request.Request(url + path, json.dumps(body).encode(), method="POST",
            headers={"Content-Type": "application/json", "Authorization": "Basic " + auth})
        try:
            with urllib.request.urlopen(req, timeout=30) as r: return r.status, "ok"
        except urllib.error.HTTPError as e:
            if e.code == 409: return 409, "already exists"
            return e.code, e.read().decode()[:120]
        except Exception as e:  # timeout / connection reset → retry
            if attempt == 4: return 0, f"failed after {attempt} tries: {e}"
            time.sleep(5 * attempt)
for n in seed.get("business_numbers", []):
    s, msg = post("/api/business-numbers", n); print(f'  business {n.get("display_number")}: {s} {msg}')
for g in seed.get("groups", []):
    s, msg = post("/api/groups", g); print(f'  group {g.get("name")}: {s} {msg}')
PY
fi

cat <<EOF

$(say "UP: $URL")
  Phones  : $URL/client        Admin: $URL/admin        API docs: $URL/docs
  ComDove : set META_GRAPH_API_BASE_URL=$URL
  Stop    : infra/scripts/down.sh   (auto-off after idle — see README)
  DNS can take a few minutes on other computers (TTL 60 s).
EOF
