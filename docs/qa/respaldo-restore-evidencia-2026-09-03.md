# Respaldo → restauración → verificación: evidencia (2026-09-03)

Corrida real, no razonada. Producción se leyó (lectura, nunca escritura) y la
restauración se ensayó contra un PostgreSQL limpio en PGlite, que es el destino
seguro disponible en esta máquina.

**Este documento no contiene ni un dato personal**: sólo conteos, hashes y
resultados. El archivo de respaldo vive fuera del repositorio y contiene
exámenes de laboratorio de una familia real.

## Lo que se corrió

```bash
node scripts/respaldo.mjs
node scripts/respaldo-restaurar.mjs ultimo --destino pglite
```

## Primer intento: FAIL

El respaldo se escribió y el ensayo de restauración **falló**:

```
FALLÓ AL RESTAURAR consumption_logs (8 filas).
  new row for relation "consumption_logs" violates check constraint
  "intake_log_inventory_iff_served"
```

**Causa, medida contra producción.** La 0038 agrega esa restricción con
`NOT VALID`, que en PostgreSQL significa una cosa muy precisa: no revises las
filas que ya están, revisa todas las que vengan. Es como se agrega una regla sin
declarar inválido el pasado, y acá está bien usado: exime a los consumos
anteriores a que existieran los registros de servicio.

Producción tiene 8 filas de `consumption_logs` con `serving_record_id` nulo y
`affects_inventory` verdadero — consumo legítimo, anterior al modelo. Al
restaurar dejan de ser "las que ya estaban" y pasan a ser INSERTs nuevos: la
regla los revisa y los rechaza.

**Lo que eso significaba:** el respaldo se escribía, decía estar bien, y no se
podía restaurar. La única salida que quedaba era reescribir historia clínica para
que pasara una regla nacida después. Un respaldo que no se puede restaurar no es
un respaldo.

## El arreglo

`scripts/respaldo-nucleo.mjs`, pasos 7-bis y 8-bis: antes de cargar se sueltan
las restricciones CHECK marcadas `NOT VALID` (consultadas al catálogo, no una
lista escrita a mano) y después de cargar se reponen **con la misma definición y
el mismo NOT VALID**.

No afloja nada: el destino queda con exactamente la misma regla y el mismo
alcance que el origen, que es la definición de una restauración fiel. Las
restricciones VALIDADAS no se tocan — si una de esas rechaza una fila, el
respaldo tiene un problema de verdad y tiene que doler.

**Regresión:** `web/src/integration/respaldo-camino-real.test.ts`, bloque «las
restricciones NOT VALID no impiden restaurar». Reproduce el caso en chico y
comprueba las tres cosas: que la fila exenta vuelve, que la regla queda puesta, y
que queda **NOT VALID** (si volviera validada, rechazaría la fila que exime).

## Segundo intento: PASS

```
Restricciones NOT VALID que se sueltan para cargar y se reponen igual: 2
  · consumption_logs.intake_log_inventory_iff_served
  · nutrition_goals.goals_engine_never_active
Restricciones repuestas: 2 (con su NOT VALID, igual que en el origen).

Verificando…
  Hash idéntico en 123/123 tablas.
  Llaves foráneas comprobadas: 394 de 394 · huérfanos: 0
  Datos clínicos restaurados:
    - lab_documents: 1 · lab_observations: 2 · lab_extraction_candidates: 2
    - member_clinical_restrictions: 2 · meal_clinical_assessments: 5
    - clinical_impact_reviews: 2
  Storage al momento del respaldo: 0 archivo(s) inventariado(s).

Aplicando las 2 migraciones posteriores sobre los datos restaurados…
  ok  0061_eventos_borrador_y_comidas_cubiertas.sql
  ok  0062_cierre_seguridad.sql

ENSAYO OK: el respaldo se restaura completo y vuelve idéntico
(12161 filas, 123 tablas).
```

| comprobación | resultado |
|---|---|
| Respaldo generado | **PASS** — 123 tablas · 12.161 filas · hash verificado |
| Restauración ejecutada | **PASS** — destino PGlite limpio |
| Integridad: hashes por tabla | **PASS** — 123/123 idénticos |
| Integridad referencial | **PASS** — 394 FK · 0 huérfanos |
| Migraciones pendientes encima | **PASS** — 0061 y 0062 aplican sobre los datos |
| Regresión escrita | **PASS** — 47 tests verdes en respaldo-camino-real |

## Lo que esta corrida NO prueba

- **Restauración contra un Supabase real.** El destino fue PGlite. El camino
  `--destino supabase --si-estoy-seguro` está cubierto por
  `respaldo-camino-real.test.ts` contra un PGlite que hace de Supabase, no contra
  un proyecto de verdad. Se cierra cuando exista staging.
- **Los binarios de Storage.** El respaldo inventaría los archivos, no los baja.
  Al momento de esta corrida había 0 archivos, así que no hubo nada que perder,
  pero eso cambia en cuanto alguien suba un examen.
- **El tiempo de una restauración real.** 12.161 filas es la base de hoy; no dice
  nada sobre cuánto tardará con dos años de historia.
