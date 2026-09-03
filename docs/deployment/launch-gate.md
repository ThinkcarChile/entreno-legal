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
| 2 | Suite de pruebas | **PASS** | 2393 pruebas, 136 archivos, 0 rojas | no | — |
| 3 | Tipos y lint | **PASS** | `tsc --noEmit` 0 errores; `eslint --max-warnings 0` limpio | no | — |
| 4 | CI remoto (job `web`) | **PASS** | verde tras separar defecto de brecha de despliegue | no | — |
| 5 | Cadena en PostgreSQL real (job `db`) | **PASS** | `db-test.sh` verde en CI desde `a873a10` | no | — |
| 6 | Eventos: DRAFT + comidas cubiertas | **PASS** | 0061; 17 pruebas; 14 mutaciones | no | — |
| 7 | Cierre de seguridad SECDEF | **PASS** | 0062; anon pasa de 262 a **0** funciones ejecutables | no | — |
| 8 | Respaldo → restauración → verificación | **PASS** | 12.161 filas, 123/123 hashes, 394 FK, 0 huérfanos | no | — |
| 9 | Empaquetado de la PWA | **PASS** | `npm run pwa:empaquetar`; valida y falla si falta algo | no | — |
| 10 | Service worker: qué no cachea | **PASS** | sin orígenes cruzados, sin `/api/`, sin URLs firmadas | no | — |
| 11 | Recetario íntegro | **PASS** | 458 versiones publicadas, 234 alimentos, 241 fichas | no | — |
| 12 | Suite E2E implementada | **PASS** | 15 archivos, 142 casos × 4 anchos = 568; `--list` los lista | no | — |
| 13 | **E2E ejecutados** | **NOT_RUN** | no existe staging; se saltan con motivo | **SÍ** | crear staging |
| 14 | Proyecto de staging | **BLOCKED** | el token no lee la organización: plan y costo desconocidos | **SÍ** | el dueño mira el plan y decide |
| 15 | 0061 y 0062 en producción | **BLOCKED** | selladas, sin aplicar; acción irreversible | **SÍ** | autorización del dueño |
| 16 | Hosting elegido | **BLOCKED** | faltan las respuestas de los proveedores | **SÍ** | `hosting-checklist.md` |
| 17 | Auth de producción (dominio) | **BLOCKED** | `site_url` en `localhost:3000`, redirects vacíos | **SÍ** | depende del hosting |
| 18 | Confirm Email | **BLOCKED** | `mailer_autoconfirm = true` (desactivado) | **SÍ** | depende del dominio |
| 19 | Restauración contra Supabase real | **NOT_RUN** | el ensayo fue contra PGlite | no | se cierra con staging |
| 20 | Prueba en teléfono real | **NOT_RUN** | Playwright emula, no reemplaza | no | checklist de lanzamiento |
| 21 | Revisión visual de las pantallas nuevas | **NOT_RUN** | verificado por tipos y guardianes, no en un navegador | no | el dueño mira |

## Los seis bloqueantes, en el orden en que se destraban

1. **Decidir el hosting** (#16) → con eso se define el dominio.
2. **Dominio en Auth** (#17) y **activar Confirm Email** (#18). Mientras
   `mailer_autoconfirm` siga en `true`, cualquiera se registra con un correo que
   no es suyo. El lanzamiento público está bloqueado por esto.
3. **Crear staging** (#14), sabiendo el costo. Sin staging no hay #13.
4. **Ejecutar los E2E** (#13). Recién ahí se sabe si los 142 casos pasan; hoy sólo
   se sabe que compilan y se listan.
5. **Aplicar 0061 y 0062** (#15). El ensayo con datos ya está probado para las
   migraciones anteriores; para estas dos hay que correrlo antes.

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
