#!/usr/bin/env bash
# Forced command for the CI deploy key in ~/.ssh/authorized_keys:
#   command="/home/ubuntu/pt-ci-entry.sh",restrict ssh-ed25519 AAAA... pt-ci-deploy
# The key can do exactly one thing: update the demo to a commit SHA that is on main.
# (A copy outside the repository, so a checkout can never change the entry point.)
set -euo pipefail
SHA="${SSH_ORIGINAL_COMMAND:-}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "expected a 40-hex commit sha" >&2; exit 2; }
exec bash /home/ubuntu/property-token/deploy/demo-server/update.sh "$SHA"
