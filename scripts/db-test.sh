#!/usr/bin/env bash
# Aplica las migraciones + seeds en un PostgreSQL local efímero y corre los tests
# SQL (RLS, barcode por ámbito, UNKNOWN != ZERO).
#
#   scripts/db-test.sh                            levanta la base y corre todo
#   scripts/db-test.sh --imprimir-orden [arnés]   solo imprime la secuencia y sale
#
# Funciona en Linux (CI, socket Unix) y en Windows/Git Bash (TCP en loopback,
# porque Windows no soporta sockets Unix en PostgreSQL).
#
# ---------------------------------------------------------------------------
# EL ORDEN NO SE INVENTA ACÁ, Y ESE ES EL PUNTO DEL ARCHIVO
#
# Este script aplicaba `supabase/migrations/*.sql` y `supabase/seed/*.sql` con
# un `for` sobre el glob, o sea POR NOMBRE DE ARCHIVO. Eso es una segunda
# respuesta a «¿en qué orden va la cadena?», y ya había una: la lista
# `MIGRACIONES` de `web/src/integration/harness.ts`, que es la secuencia que
# ejercitan las pruebas y la que aplica `scripts/poner-al-dia.mjs`. Dos dueños
# del mismo dato es exactamente cómo el repo y producción se separaron.
#
# Con las migraciones la diferencia todavía no se nota: el alfabético pone la
# 0036 antes que la 0037 y esas dos no comparten un solo objeto, así que las dos
# secuencias dejan el mismo esquema. Con los SEEDS sí se notaba, y hacía rato:
# el glob ponía `dev_recipes_biblioteca.sql` ANTES que `dev_recipes_seed.sql`
# —«biblioteca» < «seed»— y la biblioteca anida recetas que aquel publica. El
# job `db` de CI moría ahí, en cada push.
#
# Por eso la secuencia se DERIVA del arnés, y si no se puede leer, este script
# no corre: una cadena inventada bajo las pruebas es peor que no probar nada,
# porque termina en verde.
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODO="${1:-}"
# El arnés se puede apuntar a otro archivo SOLO para probar este guardián:
# web/src/integration/orden-de-migraciones.test.ts le pasa una copia mutilada y
# comprueba que acá se muera con ruido en vez de seguir con una lista a medias.
ARNES="${2:-$ROOT/web/src/integration/harness.ts}"

case "$MODO" in
  "" | --imprimir-orden) ;;
  *)
    echo "Uso: scripts/db-test.sh [--imprimir-orden [ruta-al-arnes]]" >&2
    exit 2
    ;;
esac

morir() {
  printf '%s\n' "" "$@" "" >&2
  exit 1
}

# Las entradas "supabase/…" de una lista del arnés, en el orden en que están
# escritas. Los comentarios de esa lista traen comillas y texto libre; el patrón
# sólo reconoce rutas, así que no los confunde con archivos.
lista_del_arnes() {
  awk -v n="$1" '
    index($0, "const " n " = [") { dentro = 1; next }
    dentro && /^\];/ { exit }
    dentro { print }
  ' "$ARNES" | grep -oE '"supabase/(migrations|seed)/[^"]+"' | tr -d '"'
}

[ -f "$ARNES" ] || morir \
  "No encuentro el arnés de pruebas: $ARNES" \
  "" \
  "De ahí sale el ORDEN de la cadena (lista MIGRACIONES) y acá no se adivina:" \
  "ordenar por nombre de archivo pone la 0036 antes que la 0037, y la biblioteca" \
  "de recetas antes que el seed que publica las recetas que ella anida."

CADENA=()
while IFS= read -r entrada; do
  [ -n "$entrada" ] && CADENA+=("${entrada#supabase/migrations/}")
done < <(lista_del_arnes MIGRACIONES || true)

SEMILLAS=()
while IFS= read -r entrada; do
  [ -n "$entrada" ] && SEMILLAS+=("${entrada#supabase/seed/}")
done < <(lista_del_arnes SEEDS || true)

[ "${#CADENA[@]}" -gt 0 ] || morir \
  "No pude leer la lista MIGRACIONES de $ARNES." \
  "" \
  "Si la lista cambió de forma hay que actualizar este script Y scripts/poner-al-dia.mjs," \
  "que la lee igual. Lo que NO se hace es seguir con el orden alfabético: esa secuencia" \
  "no la ejercita ninguna prueba."

[ "${#SEMILLAS[@]}" -gt 0 ] || morir \
  "No pude leer la lista SEEDS de $ARNES." \
  "" \
  "El orden de los seeds no es estético: dev_recipes_biblioteca.sql anida recetas que" \
  "publica dev_recipes_seed.sql, y al revés se cae. No se ordena por nombre de archivo."

# El NÚMERO es el contrato (misma regla que resolverMigracion() del arnés y que
# verificar-estado-produccion.mjs): el sufijo descriptivo lo elige quien escribe
# la migración. Dos archivos con el mismo número es error ruidoso, no una
# elección al azar.
resolver_migracion() {
  local base="$1" numero candidatos=()
  if [ -f "$ROOT/supabase/migrations/$base" ]; then
    printf '%s\n' "$base"
    return 0
  fi
  numero="${base:0:4}"
  for ruta in "$ROOT/supabase/migrations/${numero}"_*.sql; do
    [ -f "$ruta" ] && candidatos+=("$(basename "$ruta")")
  done
  case "${#candidatos[@]}" in
    1) printf '%s\n' "${candidatos[0]}" ;;
    0) morir "El arnés nombra $base y no existe, ni ninguna otra con el prefijo $numero." \
      "Los tests NO se saltan una migración: escríbela antes de correr esto." ;;
    *) morir "Hay ${#candidatos[@]} migraciones con el prefijo $numero (${candidatos[*]})." \
      "Deja una sola o nómbrala exacto en la lista MIGRACIONES del arnés." ;;
  esac
}

ORDEN=()
for base in "${CADENA[@]}"; do
  ORDEN+=("$(resolver_migracion "$base")")
done

# Migraciones en el disco que el arnés todavía no nombra (las escribe otro
# agente y se enganchan después). Van DESPUÉS de la cadena, que es exactamente
# donde las aplican sus propias pruebas de integración: permisos-plan.test.ts y
# sprint12-adaptive.test.ts levantan la base completa y recién ahí las corren.
# Y se anuncian fuerte: una migración que ninguna lista nombra es una que nadie
# ordena.
HUERFANAS=()
for ruta in "$ROOT"/supabase/migrations/*.sql; do
  base="$(basename "$ruta")"
  esta_en_la_cadena=0
  for f in "${ORDEN[@]}"; do
    if [ "$f" = "$base" ]; then
      esta_en_la_cadena=1
      break
    fi
  done
  [ "$esta_en_la_cadena" -eq 0 ] && HUERFANAS+=("$base")
done

for base in "${SEMILLAS[@]}"; do
  [ -f "$ROOT/supabase/seed/$base" ] || morir \
    "El arnés nombra el seed $base y no existe en supabase/seed/."
done

TODAS=("${ORDEN[@]}")
[ "${#HUERFANAS[@]}" -gt 0 ] && TODAS+=("${HUERFANAS[@]}")

if [ "$MODO" = "--imprimir-orden" ]; then
  # stdout: SOLO la secuencia, una ruta por línea, para que un guardián pueda
  # compararla contra el arnés sin adivinar. Lo demás va a stderr.
  for f in "${TODAS[@]}"; do printf 'supabase/migrations/%s\n' "$f"; done
  for f in "${SEMILLAS[@]}"; do printf 'supabase/seed/%s\n' "$f"; done
  exit 0
fi

DBDIR="${TMPDIR:-/tmp}/mesa-familiar-pgtest"
PORT=54329

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
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

echo "Orden tomado de la lista MIGRACIONES del arnés (${#ORDEN[@]} migraciones)."
if [ "${#HUERFANAS[@]}" -gt 0 ]; then
  echo ""
  echo "AVISO: ${#HUERFANAS[@]} migración(es) en el disco que el arnés NO nombra:"
  for f in "${HUERFANAS[@]}"; do echo "   $f"; done
  echo "Van al final, después de la cadena. Mientras no estén en la lista MIGRACIONES de"
  echo "harness.ts, ninguna prueba de integración las ejercita dentro de la cadena."
  echo ""
fi

psql -v ON_ERROR_STOP=1 -q -f "$ROOT/supabase/tests/auth_stub.sql"
for f in "${TODAS[@]}"; do
  echo "aplicando $f"
  psql -v ON_ERROR_STOP=1 -q -f "$ROOT/supabase/migrations/$f"
done
for f in "${SEMILLAS[@]}"; do
  echo "aplicando seed $f"
  psql -v ON_ERROR_STOP=1 -q -f "$ROOT/supabase/seed/$f"
done
for f in "$ROOT"/supabase/tests/rls_*.sql; do
  echo "ejecutando tests $(basename "$f")"
  psql -v ON_ERROR_STOP=1 -q -f "$f"
done
echo "DB OK: migraciones + seed + tests SQL"
