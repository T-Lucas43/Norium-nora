#!/bin/sh
set -eu
if [ "${DATABASE_PROVIDER:-postgresql}" != postgresql ]; then
  echo 'Este runtime Evolution exige PostgreSQL.' >&2
  exit 1
fi
node node_modules/prisma/build/index.js migrate deploy --schema prisma/postgresql-schema.prisma
exec node dist/main.js
