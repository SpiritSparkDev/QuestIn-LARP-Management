#!/bin/sh
# Restore a backup made by backup.sh.
#   restore.sh [--yes] <db-….dump[.age]> [uploads-….tar.gz[.age]]
# Stop the app first (docker compose stop app). The database content is
# replaced in one transaction. Encrypted files (.age) need the private key in
# the file named by BACKUP_AGE_IDENTITY. Afterwards start the app; it runs the
# migrations itself, so a dump older than the code is brought up to date.
set -eu

assume_yes=0
if [ "${1:-}" = "--yes" ]; then assume_yes=1; shift; fi
[ $# -ge 1 ] || { echo "usage: restore.sh [--yes] <db dump> [uploads archive]" >&2; exit 2; }
db_dump=$1
uploads=${2:-}
UPLOADS_DIR=${UPLOADS_DIR:-}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Verifies the checksum next to the file (if any) and returns the plain file.
plain() {
  src=$1
  if [ -f "$src.sha256" ]; then
    (cd "$(dirname "$src")" && sha256sum -c "$(basename "$src").sha256" >&2)
  fi
  case "$src" in
    *.age)
      [ -n "${BACKUP_AGE_IDENTITY:-}" ] || { echo "BACKUP_AGE_IDENTITY is required for $src" >&2; exit 2; }
      out="$work/$(basename "${src%.age}")"
      age -d -i "$BACKUP_AGE_IDENTITY" -o "$out" "$src"
      echo "$out"
      ;;
    *) echo "$src" ;;
  esac
}

if [ "$assume_yes" -ne 1 ]; then
  printf 'This REPLACES the database "%s" on host "%s"' "${PGDATABASE:-?}" "${PGHOST:-local}"
  [ -n "$uploads" ] && printf ' and the contents of %s' "${UPLOADS_DIR:-?}"
  printf '. Continue? [y/N] '
  read -r answer
  [ "$answer" = "y" ] || { echo "aborted"; exit 1; }
fi

dump_file=$(plain "$db_dump")
echo "restoring database"
pg_restore --clean --if-exists --no-owner --single-transaction --exit-on-error \
  --dbname="${PGDATABASE:?PGDATABASE is not set}" "$dump_file"

if [ -n "$uploads" ]; then
  [ -n "$UPLOADS_DIR" ] || { echo "UPLOADS_DIR is not set" >&2; exit 2; }
  archive=$(plain "$uploads")
  echo "restoring uploads into $UPLOADS_DIR"
  mkdir -p "$UPLOADS_DIR"
  tar -xzf "$archive" -C "$UPLOADS_DIR"
fi
echo "restore finished - start the app now"
