# Entornos: LOCAL, STAGING y PRODUCCIÓN (§46)

Este documento dice **qué variable vive en qué entorno y quién la lee**. Nunca
lleva valores: los valores viven en archivos que `.gitignore` mantiene fuera de
la historia, y los nombres son públicos a propósito, porque el nombre es el
contrato.

Hay UNA base de producción con los datos de una familia real. Todo lo que sigue
está escrito para que sea imposible apuntarle sin querer.

---

## La regla que ordena todo lo demás

**Un secreto entra al proceso del servidor web solo si la app lo necesita para
funcionar.** Los otros viven aparte y los leen únicamente los scripts.

Next carga `web/.env.local` COMPLETO dentro de `process.env` del servidor. Todo
lo que esté ahí queda a un `fetch` de distancia de cualquier bug de render. Por
eso:

| secreto | dónde vive | quién lo lee | por qué no puede estar en el servidor web |
|---|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | `.env.deploy` (raíz, ignorado por git) | `scripts/aplicar-migracion.mjs`, `poner-al-dia.mjs`, `verificar-estado-produccion.mjs`, `staging-bootstrap.mjs` | es de la **Management API**: corre SQL arbitrario sobre TODA la cuenta de Supabase, no sobre un hogar |
| clave `service_role` | **en ningún archivo del repo** | nadie | se salta TODA la RLS, que es lo único que separa un hogar de otro |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `web/.env.local` | la app, servidor y navegador | está HECHA para viajar al navegador; lo que protege los datos es la RLS |

Lo vigila `web/src/lib/entorno.test.ts`, que además comprueba que ningún archivo
del repo tenga un valor con **forma** de credencial de verdad (`sbp_` + 40 hex,
o un JWT largo) — el test del nombre no atrapa un token pegado en un fixture.

---

## Las variables de la app (`web/.env.local`, ejemplo en `web/.env.example`)

El ejemplo y el código no se pueden desincronizar: `entorno.test.ts` compara la
lista del `.env.example` contra lo que `web/src` realmente lee con
`process.env`, y falla si sobra o falta una.

| variable | LOCAL | STAGING | PRODUCCIÓN | qué pasa si falta |
|---|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | proyecto de desarrollo | proyecto de staging (`--ref` de `staging-bootstrap.mjs`) | proyecto de la familia | la app lanza al arrancar, con el nombre de la variable en el mensaje |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ídem | ídem | ídem | ídem |
| `ASSISTANT_PROVIDER` | vacío (= `fake`) | vacío o `remoto` | `remoto` si se quiere IA | queda `fake`: la app **sigue funcionando** (ver §52 en `observabilidad.md`) |
| `ASSISTANT_API_URL` | vacío | del proveedor | del proveedor | `hasAiEnv()` da `false` y el asistente responde "no disponible" en vez de reventar |
| `ASSISTANT_API_KEY` | vacío | del proveedor | del proveedor | ídem |
| `ASSISTANT_MODEL` | vacío | del proveedor | del proveedor | el adaptador usa su valor por omisión |
| `APP_VERSION` | vacío | la etiqueta del build | la etiqueta del build | `/api/health` responde `"version": null`. **null, no "0.0.0"**: un número inventado hace que alguien crea que sabe qué está corriendo |
| `SCHEMA_VERSION` | vacío | número de la última migración aplicada | ídem | `/api/health` responde `"schema": null` |

`NODE_ENV` no se declara en ninguna parte: la pone Node/Next. Fijarla a mano es
como se termina sirviendo un build de desarrollo en producción.

## Las variables de los scripts (`.env.deploy`, en la raíz)

| variable | quién la lee | notas |
|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | los cuatro scripts de despliegue | sin ella los scripts se **niegan** y dicen dónde ponerla; no caen a un modo "sin token" |
| `STAGING_PROJECT_REF` | `scripts/staging-bootstrap.mjs` | el ref del proyecto de staging |

`E2E_BASE_URL` la lee `web/playwright.config.ts` y se pasa por línea de comandos
o por el entorno de CI; no vive en ningún `.env` del repo. Sin ella, Playwright
no corre: el contrato es que los E2E van SOLO contra staging.

---

## A qué proyecto le habla cada script

Ésta es la parte que puede tocar los datos de la familia, así que va explícita.

- **Sin `--ref`**, los scripts hablan al proyecto de `NEXT_PUBLIC_SUPABASE_URL`
  — es decir, **producción**, si eso es lo que dice tu `.env.local`.
- **Con `--ref <proyecto>`**, hablan a ese proyecto (staging) y no miran ninguna
  URL. Un `--ref` sin valor NO cae al proyecto por omisión: revienta. Caer a
  producción por un argumento mal escrito es exactamente el accidente que ese
  comportamiento evita.
- `node scripts/verificar-estado-produccion.mjs` **sin `--escribir`** solo lee.
  Es el comando seguro para preguntar en qué estado está la base real.

## Los tres entornos, en una frase cada uno

**LOCAL** — tu máquina contra un proyecto de Supabase de desarrollo, o contra
PGlite si solo corres la suite. La suite NUNCA toca la red: `vitest.config.ts`
fija `ASSISTANT_PROVIDER: "fake"` y `guardas-ia.test.ts` comprueba que ningún
archivo de prueba nombre siquiera el adaptador remoto.

**STAGING** — un proyecto de Supabase aparte, levantado desde cero con
`node scripts/staging-bootstrap.mjs --ref <proyecto>`. Es el único lugar donde
corren los E2E de Playwright, y el único donde se ensaya un despliegue con datos
que no son de nadie.

**PRODUCCIÓN** — un proyecto, una familia, 59 migraciones aplicadas
(0001→0060, sin 0049). Lo que tiene puesto lo declara
`supabase/estado-produccion.json` y lo verifica con testigos en vivo
`verificar-estado-produccion.mjs`. Nada llega acá sin haber pasado por el ensayo
de `web/src/integration/ensayo-despliegue.test.ts`, que aplica las pendientes
**encima del estado real**, que no es lo mismo que correr la cadena desde cero.

## Al rotar un secreto

1. Rótalo en Supabase (Settings → API para las claves; Account → Access Tokens
   para el de la Management API).
2. Cámbialo en `web/.env.local` y en `.env.deploy` según corresponda.
3. Cámbialo en el hosting (variables de entorno del proceso, no un archivo
   subido).
4. Reinicia el proceso: Next lee el entorno al arrancar.
5. Comprueba con `curl https://<dominio>/api/health` que responde
   `{"ok":true,…}`. Si responde `ok:false`, la app no está hablando con la base
   y el motivo está en el log del servidor (`docs/deployment/observabilidad.md`).

**No rotes la anon key sin avisar**: cambia el JWT que llevan las sesiones
abiertas y toda la familia queda deslogueada.
