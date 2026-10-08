#!/bin/sh
# Backup of the QuestIn database (pg_dump custom format) and the local uploads.
# Run by crond inside the backup container (see docker-compose.yml) or by hand.
#
# Connection:   PGHOST / PGUSER / PGPASSWORD / PGDATABASE (libpq standard)
# Settings:     BACKUP_DIR (/backups), UPLOADS_DIR (skipped when missing/empty)
#               KEEP_DAILY (7), KEEP_WEEKLY (4), KEEP_MONTHLY (6)
#               BACKUP_AGE_RECIPIENT  age public key; encrypts every file
#               BACKUP_OFFSITE_REMOTE rclone destination, e.g. offsite:bucket/path
#               BACKUP_PING_URL       dead man's switch (success -> URL, failure -> URL/fail)
#               DISK_WARN_PERCENT (80)
# The ENCRYPTION_KEY of the app is NOT part of the backup on purpose: keep it
# separately (password manager), see docs/betrieb-backup.md.
set -eu

BACKUP_DIR=${BACKUP_DIR:-/backups}
UPLOADS_DIR=${UPLOADS_DIR:-}
KEEP_DAILY=${KEEP_DAILY:-7}
KEEP_WEEKLY=${KEEP_WEEKLY:-4}
KEEP_MONTHLY=${KEEP_MONTHLY:-6}
DISK_WARN_PERCENT=${DISK_WARN_PERCENT:-80}
BACKUP_PING_URL=${BACKUP_PING_URL:-}
BACKUP_AGE_RECIPIENT=${BACKUP_AGE_RECIPIENT:-}
BACKUP_OFFSITE_REMOTE=${BACKUP_OFFSITE_REMOTE:-}

log() { printf '%s backup: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

ping_url() {
  [ -n "$BACKUP_PING_URL" ] || return 0
  curl -fsS -m 10 --retry 3 -o /dev/null "$1" || log "WARN heartbeat ping failed ($1)"
}

finished=0
on_exit() {
  if [ "$finished" -ne 1 ]; then
    log "FAILED"
    ping_url "${BACKUP_PING_URL%/}/fail"
  fi
}
trap on_exit EXIT

mkdir -p "$BACKUP_DIR"
stamp=$(date '+%Y-%m-%d-%H%M%S')
tmp="$BACKUP_DIR/.tmp-$stamp"
mkdir -p "$tmp"

# 1. database -------------------------------------------------------------
db_file="db-$stamp.dump"
log "dumping database"
pg_dump --format=custom --file="$tmp/$db_file"
pg_restore --list "$tmp/$db_file" >/dev/null   # readable? (not a full restore test)
set -- "$db_file"

# 2. uploads --------------------------------------------------------------
if [ -n "$UPLOADS_DIR" ] && [ -d "$UPLOADS_DIR" ] && [ -n "$(ls -A "$UPLOADS_DIR" 2>/dev/null)" ]; then
  up_file="uploads-$stamp.tar.gz"
  log "archiving uploads"
  tar -czf "$tmp/$up_file" -C "$UPLOADS_DIR" .
  tar -tzf "$tmp/$up_file" >/dev/null
  set -- "$@" "$up_file"
fi

# 3. encrypt, checksum, publish -------------------------------------------
for f in "$@"; do
  final="$f"
  if [ -n "$BACKUP_AGE_RECIPIENT" ]; then
    age -r "$BACKUP_AGE_RECIPIENT" -o "$tmp/$f.age" "$tmp/$f"
    rm -f "$tmp/$f"
    final="$f.age"
  fi
  (cd "$tmp" && sha256sum "$final" > "$final.sha256")
  mv "$tmp/$final" "$tmp/$final.sha256" "$BACKUP_DIR/"
done
rmdir "$tmp"
log "stored set $stamp in $BACKUP_DIR"

# 4. rotation: newest per day/week/month, plus everything from today -------
today=$(date '+%Y-%m-%d')
find "$BACKUP_DIR" -maxdepth 1 -name 'db-*.dump*' | sed -n 's|.*/db-\([0-9-]*\)\.dump.*|\1|p' | sort -u -r | awk \
  -v today="$today" -v kd="$KEEP_DAILY" -v kw="$KEEP_WEEKLY" -v km="$KEEP_MONTHLY" '
  function jdn(y, m, d,   a, yy, mm) {
    a = int((14 - m) / 12); yy = y + 4800 - a; mm = m + 12 * a - 3
    return d + int((153 * mm + 2) / 5) + 365 * yy + int(yy / 4) - int(yy / 100) + int(yy / 400) - 32045
  }
  {
    day = substr($0, 1, 10); mon = substr($0, 1, 7)
    split(day, p, "-"); week = int((jdn(p[1] + 0, p[2] + 0, p[3] + 0) + 1) / 7)
    keep = (NR == 1) || (day == today)
    if (!(day in sd)) { sd[day] = 1; nd++; if (nd <= kd) keep = 1 }
    if (!(week in sw)) { sw[week] = 1; nw++; if (nw <= kw) keep = 1 }
    if (!(mon in sm)) { sm[mon] = 1; nm++; if (nm <= km) keep = 1 }
    if (!keep) print $0
  }' | while read -r old; do
    log "rotating out set $old"
    rm -f "$BACKUP_DIR"/*-"$old".*
  done

# 5. offsite copy -----------------------------------------------------------
if [ -n "$BACKUP_OFFSITE_REMOTE" ]; then
  log "copying to offsite remote"
  rclone copy "$BACKUP_DIR" "$BACKUP_OFFSITE_REMOTE" --include "*-$stamp.*" --exclude ".tmp-*/**"
fi

# 6. disk warning -----------------------------------------------------------
used=$(df -P "$BACKUP_DIR" | awk 'NR == 2 { gsub("%", "", $5); print $5 }')
if [ "${used:-0}" -ge "$DISK_WARN_PERCENT" ]; then
  log "WARN backup volume is ${used}% full"
fi

finished=1
log "done"
ping_url "$BACKUP_PING_URL"
