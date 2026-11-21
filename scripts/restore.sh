#!/usr/bin/env bash
# استعادة نسخة احتياطية إلى قاعدة فارغة: ./scripts/restore.sh backups/kayan-XXXX.dump
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL required}"
FILE="${1:?usage: restore.sh <backup-file>}"
pg_restore "$DATABASE_URL" --clean --if-exists --no-owner "$FILE"
echo "restored from $FILE"
