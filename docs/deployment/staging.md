# Staging: para qué existe y cómo se levanta

Staging existe por una razón concreta y no negociable: **los E2E no pueden correr
en ningún otro lado.**

- Contra **producción**, no: los E2E crean, editan y borran. Ahí viven los
  exámenes de una familia real.
- Contra **PGlite**, tampoco: la aplicación no habla SQL, habla PostgREST con
  Supabase. PGlite no tiene PostgREST, ni Auth, ni Storage. Una suite que corre
  ahí prueba otra cosa y da una confianza que no corresponde.

Mientras no exista staging, `web/e2e/**` se salta entero y el informe dice
**NOT_RUN**. Nunca PASS. Eso está puesto en el contrato (`e2e/fixtures/contrato.ts`)
como un fixture `auto`, así que no depende de que nadie se acuerde.

## Antes de crear el proyecto: el costo

**No lo crees sin saber cuánto cuesta.** El plan Free de Supabase incluye dos
proyectos activos; con uno ya en uso, el segundo podría entrar sin cobro. En Pro,
cada proyecto adicional suma su propio cómputo.

El token que hay en `.env.deploy` **no alcanza para averiguarlo**: lee
`/v1/projects` pero `/v1/organizations` le devuelve una lista vacía, así que el
plan de la organización no se puede leer desde acá. Medido el 2026-09-03.

Así que el orden es: **primero el dueño mira el plan en el panel de Supabase y
decide**, después se crea. Lo que se crearía:

| | |
|---|---|
| nombre | `mesa-familiar-staging` |
| organización | la misma que `mesa-familiar` |
| región | `sa-east-1` (la misma que producción: mismas latencias, mismos husos) |
| plan | el que la organización ya tenga |
| contenido | cadena completa, seeds, recetario y usuarios sintéticos |

## Cómo se levanta, una vez que existe

```bash
# 1. Ver el plan sin tocar nada
node scripts/staging-bootstrap.mjs --ref <STAGING_PROJECT_REF> --en-seco

# 2. Construirlo de verdad
node scripts/staging-bootstrap.mjs --ref <STAGING_PROJECT_REF> --aplicar
```

Es **idempotente**: se puede volver a correr sobre un staging a medio construir y
completa lo que falte, en vez de exigir empezar de cero.

Lo que hace, en orden:

1. **La cadena de migraciones completa**, en el orden del arnés — que no es el
   alfabético: la 0036 va después de la 0037. El orden sale de
   `web/src/integration/harness.ts`, así que lo que se aplica es exactamente la
   secuencia que las pruebas ejercitan.
2. **Los seeds y el recetario**, reutilizando `publicar-recetario.mjs` con el
   mismo `--ref`. Nada de esto se copia de producción.
3. **Los buckets** (`medical-documents`, `purchase-receipts`), que los crean las
   migraciones 0034 y 0045.
4. **Los tres usuarios sintéticos**: A y B en un hogar, AJENO en otro, más un
   integrante sin cuenta. Se crean por la Auth Admin API y su hogar por los
   mismos RPC que usa la aplicación.
5. **La configuración de Auth**: `site_url` y `uri_allow_list` apuntando a
   `E2E_BASE_URL`, y `mailer_autoconfirm = true` **sólo en staging** — en
   producción va en `false`, que es el Confirm Email que bloquea el lanzamiento
   mientras siga apagado.
6. **Un smoke**: los testigos del libro, preguntados a staging, y los conteos.

## Los datos

**Cien por ciento sintéticos.** No se copia ni una fila de producción — ni
siquiera "para que se parezca". Ahí hay exámenes de laboratorio de personas
reales, y un entorno de pruebas es, por definición, el lugar donde las cosas se
rompen y se miran.

El recetario sí se publica completo, porque es contenido del repositorio y no
tiene nada de nadie.

## Correr los E2E

```bash
cd web
npm run e2e:staging     # proyecto "staging": escritorio 1280
npm run e2e             # los cuatro: 1280 + móviles 320/375/430
```

Las variables van en `web/.env.staging` (copia de `.env.staging.example`) o
exportadas en la terminal. Sin `E2E_BASE_URL` no falla: **se salta**, y lo dice.

## Lo que NO hace el bootstrap

- **No crea el proyecto.** Eso es una decisión con costo y la toma el dueño.
- **No copia datos de producción.** Nunca.
- **No apaga Confirm Email en producción.** Sólo toca el proyecto que recibe por
  `--ref`, y se niega si ese ref es el de producción.
