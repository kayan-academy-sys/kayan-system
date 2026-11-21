#!/usr/bin/env bash
# نسخ احتياطي لقاعدة البيانات: pg_dump مضغوط + الاحتفاظ بآخر 30 نسخة
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL required}"
DIR="${BACKUP_DIR:-backups}"
mkdir -p "$DIR"
FILE="$DIR/kayan-$(date +%Y%m%d-%H%M%S).dump"
pg_dump "$DATABASE_URL" -Fc -f "$FILE"
ls -1t "$DIR"/kayan-*.dump | tail -n +31 | xargs -r rm -f
echo "backup written: $FILE"
