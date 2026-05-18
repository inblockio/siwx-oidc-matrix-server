#!/bin/sh
set -e

# Template environment variables into config and shim files.
# Placeholders use %% delimiters to avoid clashing with JSON/JS syntax.
sed -i "s|%%MATRIX_BASE_URL%%|${MATRIX_BASE_URL}|g" /app/config.json
sed -i "s|%%MATRIX_HOST%%|${MATRIX_HOST}|g" /app/config.json
sed -i "s|%%MATRIX_BASE_URL%%|${MATRIX_BASE_URL}|g" /app/siwx-redirect.js
sed -i "s|%%SIWEOIDC_BASE_URL%%|${SIWEOIDC_BASE_URL}|g" /app/siwx-redirect.js
sed -i "s|%%SIWEOIDC_BASE_URL%%|${SIWEOIDC_BASE_URL}|g" /app/siwx-callback.js

# Inject a synchronous gate script right after <head> that prevents Element
# from booting when the user is unauthenticated. This avoids the race where
# Element calls /_matrix/client/v3/login (disabled under MSC3861) and shows
# an error before our async OIDC redirect fires.
sed -i 's|<head>|<head><script src="siwx-gate.js"></script>|' /app/index.html

# Inject the callback script before </head> (must come before redirect script
# so it can intercept ?code= before the redirect logic fires).
sed -i 's|</head>|<script src="siwx-callback.js"></script></head>|' /app/index.html

# Inject the redirect shim script before </head>.
sed -i 's|</head>|<script src="siwx-redirect.js"></script></head>|' /app/index.html

# Inject the splash HTML fragment before </body> in Element's index.html.
sed -i '/<\/body>/r /app/siwx-splash.html' /app/index.html

# Start nginx (Element Web's default server).
exec nginx -g "daemon off;"
