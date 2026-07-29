#!/bin/sh
set -eu

PORT_VALUE="${PORT:-80}"
API_URL_VALUE="${VITE_API_URL:-}"
WS_URL_VALUE="${VITE_WS_URL:-}"

escape_js() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

cat > /usr/share/nginx/html/env.js <<EOF
window.__NORIUM_CONFIG__ = {
  API_URL: "$(escape_js "$API_URL_VALUE")",
  WS_URL: "$(escape_js "$WS_URL_VALUE")"
};
EOF

sed "s/__PORT__/${PORT_VALUE}/g" /etc/nginx/conf.d/default.conf.template > /etc/nginx/conf.d/default.conf

exec nginx -g 'daemon off;'
