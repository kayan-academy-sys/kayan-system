#!/usr/bin/env bash
# Restore only into a separately created EMPTY database. Never overwrite a working ledger.
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL required}"
FILE="${1:?usage: restore.sh <backup-file>}"
if [ "${RESTORE_TO_EMPTY_CONFIRMED:-}" != 'yes' ]; then
  echo 'Refused: set RESTORE_TO_EMPTY_CONFIRMED=yes only for a separately created empty restore database.' >&2
  exit 2
fi
TABLES=$(psql "$DATABASE_URL" -Atqc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")
if [ "$TABLES" != '0' ]; then
  echo 'Refused: target database is not empty. No tables were changed.' >&2
  exit 2
fi
pg_restore --dbname="$DATABASE_URL" --no-owner --no-acl --exit-on-error --single-transaction "$FILE"
echo 'Restore completed into the empty target. Verify counts and workflows before any cutover.'
