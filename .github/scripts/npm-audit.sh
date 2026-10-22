#!/usr/bin/env bash
# npm audit --audit-level=high that retries ONLY when the npm advisories endpoint fails (timeouts and
# "audit endpoint returned an error" failed CI on 2026-10-22 while the lockfiles audited clean).
# A real finding fails at once; an endpoint that keeps failing still fails the job (fail closed).
set -uo pipefail
for attempt in 1 2 3; do
  out=$(npm audit --audit-level=high 2>&1)
  code=$?
  printf '%s\n' "$out"
  [ "$code" -eq 0 ] && exit 0
  if ! grep -Eq 'audit endpoint returned an error|network timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up' <<<"$out"; then
    exit "$code" # a real advisory: no retry
  fi
  echo "npm advisories endpoint failed (attempt $attempt of 3); retrying in 30 s" >&2
  sleep 30
done
echo "npm audit could not reach the advisories endpoint after 3 attempts; failing closed" >&2
exit 1
