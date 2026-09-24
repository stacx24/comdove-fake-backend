#!/usr/bin/env bash
# Build comdove-fake-backend + comdove-fake-ui ON THIS LAPTOP and pack them into
# infra/.build/comdove-fake.zip. (A t4g.nano has 0.5 GB RAM — too little to
# compile TypeScript/Vite, so the server only runs finished files.)
source "$(dirname "$0")/common.sh"
need npm
need zip

# Where the UI repo is: FAKE_UI_DIR, or a sibling checkout.
UI_DIR="${FAKE_UI_DIR:-}"
if [ -z "$UI_DIR" ]; then
  for c in "$REPO_DIR/../comdove-fake-ui" "$REPO_DIR/../../comdove fake ui/comdove-fake-ui"; do
    [ -d "$c/client" ] && UI_DIR="$(cd "$c" && pwd)" && break
  done
fi
[ -n "$UI_DIR" ] && [ -d "$UI_DIR/client" ] || die "comdove-fake-ui not found. Set FAKE_UI_DIR=/path/to/comdove-fake-ui"

branch_note() { # dir expected-branch
  local b dirty
  b=$(git -C "$1" branch --show-current 2>/dev/null || echo '?')
  dirty=$(git -C "$1" status --porcelain 2>/dev/null | { grep -v '^?? infra/' || true; } | wc -l | tr -d ' ')
  echo "  $(basename "$1"): branch $b @ $(git -C "$1" rev-parse --short HEAD 2>/dev/null)$( [ "$dirty" != 0 ] && echo " ($dirty uncommitted changes)")"
  [ "$b" = "$2" ] || echo "  ⚠ expected branch '$2'"
}
say "Building from:"
branch_note "$REPO_DIR" "develop"
branch_note "$UI_DIR" "main"

say "Backend: npm ci + tsc"
(cd "$REPO_DIR" && npm ci --no-audit --no-fund --loglevel=error && npm run build --silent)

say "UI: npm ci + vite build (VITE_DATA_SOURCE=server)"
(cd "$UI_DIR/client" && npm ci --no-audit --no-fund --loglevel=error \
  && VITE_DATA_SOURCE=server VITE_WEBHOOK_URL="" npm run build --silent)

say "Packing"
STAGE="$BUILD_DIR/stage"
rm -rf "$STAGE" && mkdir -p "$STAGE/backend" "$STAGE/ui" "$STAGE/power"
cp -R "$REPO_DIR/dist" "$REPO_DIR/package.json" "$REPO_DIR/package-lock.json" "$STAGE/backend/"
cp -R "$UI_DIR/client/dist/." "$STAGE/ui/"
cp -R "$INFRA_DIR/server/power/." "$STAGE/power/"   # /power page + power endpoint
rm -f "$BUILD_ZIP"
(cd "$STAGE" && zip -qr -X "$BUILD_ZIP" .)
echo "  $BUILD_ZIP ($(du -h "$BUILD_ZIP" | cut -f1))"
