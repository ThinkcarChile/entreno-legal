#!/usr/bin/env bash
# Aplica las migraciones + seed en un PostgreSQL local efímero y corre los tests SQL
# (RLS, barcode por ámbito, UNKNOWN != ZERO). Uso: scripts/db-test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DBDIR="${TMPDIR:-/tmp}/mesa-familiar-pgtest"
PORT=54329
export PGHOST="$DBDIR/sock" PGPORT=$PORT PGUSER=postgres PGDATABASE=postgres

PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"
export PATH="$PGBIN:$PATH"

cleanup() { pg_ctl -D "$DBDIR/data" stop -m immediate >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
rm -rf "$DBDIR"; mkdir -p "$DBDIR/sock"

initdb -D "$DBDIR/data" -U postgres -A trust >/dev/null
pg_ctl -D "$DBDIR/data" -o "-p $PORT -k $DBDIR/sock -c listen_addresses=''" -w start >/dev/null

psql -v ON_ERROR_STOP=1 -q -f "$ROOT/supabase/tests/auth_stub.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "aplicando $(basename "$f")"
  psql -v ON_ERROR_STOP=1 -q -f "$f"
done
echo "aplicando seed de desarrollo"
psql -v ON_ERROR_STOP=1 -q -f "$ROOT/supabase/seed/dev_catalog_seed.sql"
echo "ejecutando tests SQL"
psql -v ON_ERROR_STOP=1 -q -f "$ROOT/supabase/tests/rls_catalog.sql"
echo "DB OK: migraciones + seed + tests SQL"
