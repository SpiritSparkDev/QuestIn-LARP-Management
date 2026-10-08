#!/bin/sh
# Entrypoint of the backup container: schedule backup.sh with crond.
set -eu
schedule=${BACKUP_CRON:-17 3 * * *}
echo "$schedule /ops/backup.sh > /proc/1/fd/1 2>&1" > /etc/crontabs/root
echo "backup schedule: $schedule"
if [ "${BACKUP_ON_START:-1}" = "1" ]; then
  /ops/backup.sh || echo "initial backup failed"
fi
exec crond -f -l 8
