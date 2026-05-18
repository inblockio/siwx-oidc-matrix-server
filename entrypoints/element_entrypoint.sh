#!/bin/sh
set -e

# Template environment variables into Element config.
sed -i "s|%%MATRIX_BASE_URL%%|${MATRIX_BASE_URL}|g" /app/config.json
sed -i "s|%%MATRIX_HOST%%|${MATRIX_HOST}|g" /app/config.json
sed -i "s|%%SIWEOIDC_BASE_URL%%|${SIWEOIDC_BASE_URL}|g" /app/config.json

# Replace Element's vector-icons favicons with inblock.io branding.
for size in 24 120 144 152 180 512 1024; do
  for f in /app/vector-icons/${size}*.png; do
    [ -f "$f" ] && cp "/app/favicon-${size}.png" "$f"
  done
done

exec nginx -g "daemon off;"
