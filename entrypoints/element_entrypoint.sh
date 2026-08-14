#!/bin/sh
set -e

# Use volume-mounted config if available (allows config updates without image rebuild).
if [ -f /app/config.json.src ]; then
  cp /app/config.json.src /app/config.json
fi

# Template environment variables into config.
# Placeholders use %% delimiters to avoid clashing with JSON syntax.
sed -i "s|%%MATRIX_BASE_URL%%|${MATRIX_BASE_URL}|g" /app/config.json
sed -i "s|%%MATRIX_HOST%%|${MATRIX_HOST}|g" /app/config.json
# permalink_prefix is Element's documented way to emit instance URLs from
# Share instead of matrix.to (which always Continues to app.element.io).
# CLIENT_HOST is already in each environment's .env. If it is unset (local
# / e2e without a public client vhost), drop the key so we do not emit
# "https://" as a prefix.
if [ -n "${CLIENT_HOST}" ]; then
  sed -i "s|%%CLIENT_HOST%%|${CLIENT_HOST}|g" /app/config.json
else
  sed -i '/"permalink_prefix"/d' /app/config.json
fi

# Replace Element's vector-icons favicons with inblock.io branding.
for size in 24 120 144 152 180 512 1024; do
  for f in /app/vector-icons/${size}*.png; do
    [ -f "$f" ] && cp "/app/favicon-${size}.png" "$f"
  done
done

# Inject the inblock.io theme-override stylesheet into index.html.
# Idempotent: only insert if the link is not already present, so a container
# restart (entrypoint re-runs on the same writable layer) cannot duplicate it.
if ! grep -q "element-theme-overrides.css" /app/index.html; then
  sed -i 's|<head>|<head><link rel="stylesheet" href="element-theme-overrides.css">|' /app/index.html
fi

# No auth-script injection. Element Web's native MSC2965/MSC3861 OIDC flow
# discovers the issuer from the homeserver's .well-known m.authentication and
# owns login end to end (the same flow Element X mobile uses). Custom redirect/
# callback/gate scripts are intentionally absent: running them alongside the
# native flow caused the single-use ?code= to be exchanged twice (the callback
# race). See docs/superpowers/plans/2026-05-29-native-oidc-callback-race-fix.md.

# Start nginx (Element Web's default server).
exec nginx -g "daemon off;"
