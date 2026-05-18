#!/bin/sh
set -e

# Template environment variables into config and login page.
sed -i "s|%%MATRIX_BASE_URL%%|${MATRIX_BASE_URL}|g" /app/config.json
sed -i "s|%%MATRIX_HOST%%|${MATRIX_HOST}|g" /app/config.json
sed -i "s|%%MATRIX_BASE_URL%%|${MATRIX_BASE_URL}|g" /app/siwx-login.html
sed -i "s|%%SIWEOIDC_BASE_URL%%|${SIWEOIDC_BASE_URL}|g" /app/siwx-login.html

# Replace Element's vector-icons favicons with inblock.io branding.
for size in 24 120 144 152 180 512 1024; do
  for f in /app/vector-icons/${size}*.png; do
    [ -f "$f" ] && cp "/app/favicon-${size}.png" "$f"
  done
done

# Inject the gate script into Element's <head> (synchronous, blocks page load).
sed -i 's|<head>|<head><script src="siwx-gate.js"></script>|' /app/index.html

exec nginx -g "daemon off;"
