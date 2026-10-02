#!/bin/sh
# Run on the server, in the directory holding docker-compose.yml and .env:
#   sh update.sh
set -e
cd "$(dirname "$0")"
docker compose pull
docker compose up -d
docker image prune -f
docker compose ps
