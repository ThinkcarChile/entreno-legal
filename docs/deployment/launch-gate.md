# Launch Gate v1 — estado medido

Corte: **2026-09-03**, commit `5403f3e` + el trabajo de esta ronda.

Cada fila dice **PASS**, **FAIL**, **BLOCKED** o **NOT_RUN**, y nada más. No hay
"casi", "aparentemente" ni "debería". Un PASS significa que se ejecutó y se miró
el resultado; si algo no se corrió, dice NOT_RUN aunque el código exista.

**PRODUCTION_READY = FALSE.** No se propone Release Candidate.

## La tabla

| # | Compuerta | Estado | Evidencia | ¿Bloquea? | Acción |
|---|---|---|---|---|---|
| 1 | Push del trabajo local | **PASS** | `ahead 0 / behind 0`, `origin` en `5403f3e` | no | — |
| 2 | Suite de pruebas | **PASS** | 2441 pruebas, 140 archivos, 0 rojas | no | — |
| 3 | Tipos y lint | **PASS** | `tsc --noEmit` 0 errores; `eslint --max-warnings 0` limpio (verificado DESPUÉS del último cambio: la primera versión de esta tabla lo declaró con una corrida vieja y CI lo desmintió) | no | — |
| 4 | CI remoto (job `web`) | **PASS** | `#33818055976` falló por tres errores de tipos en la regresión nueva (`db.query` no existe en ese tipo); corregido y vuelto a verificar | no | — |
| 5 | Cadena en PostgreSQL real (job `db`) | **PASS** | `db-test.sh` verde en CI desde `a873a10` | no | — |
| 6 | Eventos: DRAFT + comidas cubiertas | **PASS** | 0061; 17 pruebas; 14 mutaciones | no | — |
| 7 | Cierre de seguridad SECDEF | **PASS** | 0062 aplicada; anon pasa a **0** SECDEF ejecutables, medido en producción por privilegio efectivo. Las 84 RPC del contrato ejecutadas de verdad con los dos roles: `docs/qa/auditoria-post-0062.md` | no | — |
| 8 | Respaldo → restauración → verificación | **PASS** | 12.161 filas, 123/123 hashes, 394 FK, 0 huérfanos | no | — |
| 9 | Empaquetado de la PWA | **PASS** | `npm run pwa:empaquetar`; valida y falla si falta algo | no | — |
| 10 | Service worker: qué no cachea | **PASS** | sin orígenes cruzados, sin `/api/`, sin URLs firmadas | no | — |
| 11 | Recetario íntegro | **PASS** | 458 versiones publicadas, 234 alimentos, 241 fichas | no | — |
| 12 | Suite E2E implementada | **PASS** | 15 archivos, 142 casos × 4 anchos = 568; `--list` los lista | no | — |
| 13 | **E2E ejecutados** | **NOT_RUN** | no existe staging; se saltan con motivo | **SÍ** | crear staging |
| 14 | Proyecto de staging | **BLOCKED** | el token no lee la organización: plan y costo desconocidos | **SÍ** | el dueño mira el plan y decide |
| 15 | 0061 y 0062 en producción | **PASS** | ambas aplicadas; libro en 61 aplicadas / 0 pendientes / 0 desacuerdos | no | — |
| 16 | Hosting elegido | **BLOCKED** | faltan las respuestas de los proveedores | **SÍ** | `hosting-checklist.md` |
| 17 | Auth de producción (dominio) | **BLOCKED** | `site_url` en `localhost:3000`, redirects vacíos | **SÍ** | depende del hosting |
| 18 | Confirm Email | **BLOCKED** | `mailer_autoconfirm = true` (desactivado) | **SÍ** | depende del dominio |
| 19 | Restauración contra Supabase real | **NOT_RUN** | el ensayo fue contra PGlite | no | se cierra con staging |
| 20 | Prueba en teléfono real | **NOT_RUN** | Playwright emula, no reemplaza | no | checklist de lanzamiento |
| 22 | `/api/health` contra producción | **PASS** | HTTP 200 `ok:true` (2026-09-05). La sonda lee `ingredient_categories`, cuya única política es `to authenticated`: anon no evalúa nada. Vigilado por `sonda-de-vida.test.ts` en las dos puntas | no | — |
| 23 | Rutas de recuperar clave / confirmar correo / auth callback | **PASS** | `/auth/callback` (code y token_hash), `/recuperar`, `/nueva-contrasena` con sesión de recuperación exigida; 78 pruebas de auth; `docs/deployment/auth-produccion.md` | no | configurar Supabase cuando haya dominio |
| 24 | Destinos internos (`?next=`) | **PASS** | un solo validador (`lib/auth/destino.ts`); rechaza `//`, `/\`, codificados y absolutos; 4 mutaciones rojas | no | — |
| 25 | Política de la beta: entrar por invitación | **PASS** | una cuenta sin hogar ve un estado controlado y no crea hogar (`HOGAR_CREACION_ABIERTA` cerrado por omisión) | no | — |
| 21 | Revisión visual de las pantallas nuevas | **NOT_RUN** | verificado por tipos y guardianes, no en un navegador | no | el dueño mira |

## Los cinco bloqueantes, en el orden en que se destraban

Los cuatro primeros son **decisiones o manos de Francisco**; ninguno se puede
cerrar desde acá.

1. **Decidir el hosting** (#16) → con eso se define el dominio.
2. **Dominio en Auth** (#17) y **activar Confirm Email** (#18). Mientras
   `mailer_autoconfirm` siga en `true`, cualquiera se registra con un correo que
   no es suyo. El lanzamiento público está bloqueado por esto.

   **OJO CON EL ORDEN**: la ruta de auth callback (#23) ya existe. Lo que
   falta es configurar Supabase con el dominio (Site URL, Redirect URLs) ANTES
   de activar Confirm Email; el orden exacto está en `auth-produccion.md`.
3. **Crear staging** (#14), sabiendo el costo.
4. **Ejecutar los E2E** (#13), que necesitan staging. Recién ahí se sabe si los
   142 casos pasan; hoy sólo se sabe que compilan y se listan.

**Aplicar 0061 y 0062 ya no está en esta lista**: las dos están en producción, y
el libro dice 61 aplicadas / 0 pendientes / 0 desacuerdos, verificado con
testigos contra la base real.

## Lo que esta ronda encontró y cerró

**El respaldo de producción no se podía restaurar.** Ocho filas de
`consumption_logs` violaban una restricción que la 0038 agregó `NOT VALID` —
exenta para lo que ya estaba, obligatoria para lo que viene. Al restaurar dejaban
de ser "lo que ya estaba". El respaldo se escribía, decía estar bien, y la única
salida era reescribir historia clínica. Cerrado con evidencia y regresión:
`docs/qa/respaldo-restore-evidencia-2026-09-03.md`.

**El CI quedaba rojo entre escribir una migración y aplicarla.** El gate de
paridad mezclaba dos cosas distintas: un objeto que *nadie* crea (defecto) y uno
que crea una migración escrita y sellada pero sin aplicar (producción va atrás).
Ahora falla sólo por lo primero, y lo segundo se afirma entero y se imprime en la
corrida. No se silencia: se deriva del libro, así que un objeto nuevo no se puede
colar adentro, y desaparece solo al aplicar.

## Lo que NO se hizo, a propósito

Nada de wearables, CGM, importación de correo, banca, delivery ni motores nuevos.
El detalle, con su razón, en `known-limitations.md`.
