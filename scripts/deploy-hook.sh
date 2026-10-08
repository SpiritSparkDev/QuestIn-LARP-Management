#!/bin/sh
# Triggers the deploy webhook and (optionally) waits until the new version is live.
#
#   DEPLOY_HOOK_URL     POST target (Portainer stack webhook or similar). Secret.
#                       Unset/empty: nothing to do, exit 0 with a notice.
#   DEPLOY_HEALTH_URL   e.g. https://example.org/health; when set, wait until it
#                       answers 200 and reports EXPECTED_VERSION.
#   EXPECTED_VERSION    version to wait for (default: none, any 200 is enough).
#   HEALTH_TIMEOUT      seconds to wait (300), HEALTH_INTERVAL seconds between tries (10).
# Fails (exit 1) on any non-2xx answer from the hook, so a 404 is never silent.
set -eu

if [ -z "${DEPLOY_HOOK_URL:-}" ]; then
  echo "DEPLOY_HOOK_URL is not set - skipping deploy trigger"
  exit 0
fi

# The URL is a secret: never print it, only the status code.
status=$(curl -sS -o /dev/null -w '%{http_code}' -X POST --max-time 30 --retry 2 --retry-delay 3 "$DEPLOY_HOOK_URL") || {
  echo "deploy hook unreachable (connection/TLS error)" >&2
  exit 1
}
case "$status" in
  2??) echo "deploy hook answered HTTP $status" ;;
  *)
    echo "deploy hook failed: HTTP $status (404 = wrong/renewed webhook id or proxy not forwarding the path)" >&2
    exit 1
    ;;
esac

[ -n "${DEPLOY_HEALTH_URL:-}" ] || exit 0

timeout=${HEALTH_TIMEOUT:-300}
interval=${HEALTH_INTERVAL:-10}
expected=${EXPECTED_VERSION:-}
waited=0
while :; do
  body=$(curl -fsS --max-time 10 "$DEPLOY_HEALTH_URL" 2>/dev/null || true)
  version=$(printf '%s' "$body" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
  if [ -n "$body" ] && { [ -z "$expected" ] || [ "$version" = "$expected" ]; }; then
    echo "health ok, version ${version:-unknown}"
    exit 0
  fi
  if [ "$waited" -ge "$timeout" ]; then
    echo "health check timed out after ${timeout}s (last version: ${version:-none}, expected: ${expected:-any})" >&2
    exit 1
  fi
  sleep "$interval"
  waited=$((waited + interval))
done
