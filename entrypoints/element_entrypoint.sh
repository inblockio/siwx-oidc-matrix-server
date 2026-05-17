#!/bin/sh
set -e

# Template environment variables into config and shim.
# Placeholders use %% delimiters to avoid clashing with JSON/JS syntax.
sed -i "s|%%MATRIX_BASE_URL%%|${MATRIX_BASE_URL}|g" /app/config.json
sed -i "s|%%MATRIX_HOST%%|${MATRIX_HOST}|g" /app/config.json
sed -i "s|%%MATRIX_BASE_URL%%|${MATRIX_BASE_URL}|g" /app/siwx-redirect.js

# Inject the redirect shim script before </head> in Element's index.html.
sed -i 's|</head>|<script src="siwx-redirect.js"></script></head>|' /app/index.html

# Inject the splash HTML fragment before </body> in Element's index.html.
sed -i '/<\/body>/r /app/siwx-splash.html' /app/index.html

# Start nginx (Element Web's default server).
exec nginx -g "daemon off;"
