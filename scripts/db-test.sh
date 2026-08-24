#!/usr/bin/env bash
# Aplica las migraciones + seed en un PostgreSQL local efímero y corre los tests SQL
# (RLS, barcode por ámbito, UNKNOWN != ZERO). Uso: scripts/db-test.sh
#
# Funciona en Linux (CI, socket Unix) y en Windows/Git Bash (TCP en loopback,
# porque Windows no soporta sockets Unix en PostgreSQL).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DBDIR="${TMPDIR:-/tmp}/mesa-familiar-pgtest"
PORT=54329

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    PGBIN="$(ls -d /c/Program\ Files/PostgreSQL/*/bin 2>/dev/null | sort -V | tail -1)"
    DATA_DIR="$(cygpath -w "$DBDIR/data")"
    PG_OPTS="-p $PORT -c listen_addresses=127.0.0.1"
    export PGHOST=127.0.0.1
    ;;
  *)
    PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"
    DATA_DIR="$DBDIR/data"
    PG_OPTS="-p $PORT -k $DBDIR/sock -c listen_addresses=''"
    export PGHOST="$DBDIR/sock"
    ;;
esac
[ -n "$PGBIN" ] && export PATH="$PGBIN:$PATH"
export PGPORT=$PORT PGUSER=postgres PGDATABASE=postgres

command -v initdb >/dev/null 2>&1 || {
  echo "No encuentro PostgreSQL (initdb). En Windows: winget install PostgreSQL.PostgreSQL.16" >&2
  exit 1
}

cleanup() { pg_ctl -D "$DATA_DIR" stop -m immediate >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
rm -rf "$DBDIR"; mkdir -p "$DBDIR/sock"

initdb -D "$DATA_DIR" -U postgres -A trust >/dev/null
pg_ctl -D "$DATA_DIR" -o "$PG_OPTS" -w start >/dev/null

psql -v ON_ERROR_STOP=1 -q -f "$ROOT/supabase/tests/auth_stub.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "aplicando $(basename "$f")"
  psql -v ON_ERROR_STOP=1 -q -f "$f"
done
for f in "$ROOT"/supabase/seed/*.sql; do
  echo "aplicando seed $(basename "$f")"
  psql -v ON_ERROR_STOP=1 -q -f "$f"
done
for f in "$ROOT"/supabase/tests/rls_*.sql; do
  echo "ejecutando tests $(basename "$f")"
  psql -v ON_ERROR_STOP=1 -q -f "$f"
done
echo "DB OK: migraciones + seed + tests SQL"
