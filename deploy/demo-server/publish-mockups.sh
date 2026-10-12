#!/usr/bin/env bash
# Publishes docs/design as static files for nginx (/mockups/). Run as root.
set -euo pipefail
SRC=/home/ubuntu/property-token/docs/design
DEST=/var/www/pt-mockups
tmp=$(mktemp -d /var/www/.pt-mockups.XXXXXX)
cp -r "$SRC"/. "$tmp"/
chmod -R a+rX "$tmp"
rm -rf "$DEST.old"; [ -d "$DEST" ] && mv "$DEST" "$DEST.old"
mv "$tmp" "$DEST" && rm -rf "$DEST.old"
