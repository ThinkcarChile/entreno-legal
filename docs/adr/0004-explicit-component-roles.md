# 0004 — El rol culinario de un componente se declara, no se infiere

- Estado: APROBADO (implementado en la QA del Sprint 4)
- Fecha: 2026-08-24
- Decisión de baseline afectada: precisa el §15 del Sprint 4 (grasa añadida como preferencia explícita). No modifica la baseline.

## Contexto

Sprint 4 permitió que una persona declare que evita la grasa añadida, y el optimizador la quita de su porción. Para saber **qué** componente es grasa añadida se usó una heurística: está en un slot `FAT`, es opcional, y al menos el 70 % de su energía viene de la grasa.

La QA adversarial la midió contra ocho alimentos reales del catálogo:

| alimento | % de energía desde grasa | heurística | correcto |
|---|---|---|---|
| Aceite de oliva | 100,0 % | grasa añadida | grasa añadida |
| Mantequilla | 101,7 % | grasa añadida | grasa añadida |
| Mayonesa | 99,3 % | grasa añadida | grasa añadida |
| **Palta** | 82,7 % | grasa añadida | **alimento** |
| **Semillas de girasol** | 78,6 % | grasa añadida | **alimento** |
| Queso gouda | 69,3 % | alimento | alimento |
| Yogur natural | 48,7 % | alimento | alimento |
| Limón | 9,3 % | alimento | alimento |

Dos falsos positivos, y el queso se salva por 0,7 puntos: un queso crema (~75 %) también habría caído. A alguien que evita la grasa añadida se le borraba **la palta** del plato.

## Decisión

`meal_slot_components` gana una columna `role` de tipo `component_role`:

- **`MAIN`** — comida. La palta, el queso y las semillas son grasas, pero son comida.
- **`ADDED_FAT`** — grasa que se agrega al preparar: aceite, mantequilla, mayonesa. Es lo **único** que el optimizador puede quitar por preferencia de grasa añadida, y solo si además la receta lo declara opcional.
- **`SEASONING`** — aliño sin peso nutricional relevante: limón, hierbas, especias.

La regla del optimizador pasa a ser una sola condición sobre un dato declarado:

```ts
function isAddedFat(component) {
  if (component.role !== "ADDED_FAT") return false;
  return component.adjustability === "OPTIONAL" || component.isOptional;
}
```

## Por qué

Ninguna cifra de corte arregla el problema, porque **el umbral no es el problema**. El rol culinario de un ingrediente es una propiedad de la receta, no de su composición: el mismo aceite es grasa añadida en un aliño y es el alimento principal en una emulsión. Inferirlo desde los macros es adivinar, y adivinar mal significa borrarle comida del plato a alguien sin que lo haya pedido.

Además, la heurística era invisible: no producía error, no dejaba rastro, y su falla se veía como "la app decidió que no quiero palta".

## Relleno de lo existente

La migración `0006` rellena una sola vez por **categoría del ingrediente**, que sí es un dato declarado y no una inferencia nutricional: un componente opcional cuyo alimento vive en "Aceites y grasas" es `ADDED_FAT`. La palta (Frutas), el queso (Lácteos) y las semillas (Frutos secos y semillas) quedan correctamente como `MAIN`.

Eso es un relleno de migración, no una regla de ejecución: de ahí en adelante el rol lo declara la receta.

## Consecuencias

- El seed declara los roles explícitamente (aceite `ADDED_FAT`, limón `SEASONING`).
- `replace_draft_content` transporta el rol al guardar un borrador.
- **Deuda**: el formulario de recetas todavía manda siempre `MAIN`. Una receta creada a mano no puede marcar su aceite como grasa añadida hasta que la UI lo exponga.
- Hay test de regresión con los ocho alimentos de la tabla.

## Alternativas descartadas

- **Subir el umbral a 90 %**: salva la palta y las semillas, pero deja fuera la mayonesa light y cualquier aliño mezclado. Sigue siendo adivinar, solo que con otro número.
- **Usar la categoría del ingrediente en tiempo de ejecución**: es mejor que los macros, pero sigue sin distinguir el mismo aceite usado como aliño de un aceite que es el corazón del plato. Sirve para migrar una vez; no para decidir siempre.
