#!/bin/sh
set -eu

api_base="${API_BASE_URL:-http://localhost:4001/api}"

# API_BASE_URL è una variabile Railway del solo servizio frontend.
# In locale il Compose monta direttamente la cartella e non esegue questo script.
find /usr/share/nginx/html -type f -name '*.js' -print0 \
  | xargs -0 -r sed -i "s|http://localhost:4001/api|${api_base}|g"
