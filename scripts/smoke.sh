#!/usr/bin/env bash
# Build one example image, run it, and wait for its Docker HEALTHCHECK to report healthy.
# Used by CI on a runner that has Docker. Usage: scripts/smoke.sh <dir> <tag> <container-port> [build-args...]
set -euo pipefail

dir="$1"; tag="$2"; port="$3"; shift 3

docker build --pull -t "$tag" "$@" "$dir"
name="smoke-$tag"
docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --name "$name" -p "127.0.0.1:18080:$port" "$tag" >/dev/null

cleanup() { docker logs "$name" 2>&1 | tail -n 30 || true; docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

for i in $(seq 1 40); do
  status="$(docker inspect --format '{{.State.Health.Status}}' "$name")"
  [ "$status" = "healthy" ] && break
  [ "$status" = "unhealthy" ] && { echo "container reported unhealthy"; exit 1; }
  sleep 2
done
[ "$status" = "healthy" ] || { echo "container never became healthy (last status: $status)"; exit 1; }

body="$(curl -fsS "http://127.0.0.1:18080/")"
echo "GET / -> $body"
echo "healthy; image user: $(docker inspect --format '{{.Config.User}}' "$tag")"
