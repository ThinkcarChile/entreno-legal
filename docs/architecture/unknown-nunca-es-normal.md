# UNKNOWN NUNCA SIGNIFICA NORMAL

**Regla heredada por Sprint 11 en adelante** (Gate final 0→10 §6, 2026-08-25).

## La regla

Un estado desconocido (`UNKNOWN`, `INSUFFICIENT_DATA`, `UNRESOLVED`, `null`
por falta de dato) **jamás** puede ser transformado por una capa —motor,
loader, acción o pantalla— en `0`, `OK`, `SAFE`, `PASS`, verde, "bien",
"cubierto" ni omitido en silencio. El desconocido **viaja como desconocido**
hasta el ojo del usuario, y ahí se dice.

Corolarios:

1. **Los veredictos se ganan.** "Bien abastecido", "cumple el techo",
   "alcanzaría sin comprar" son afirmaciones VERIFICADAS: si el dato que las
   sostiene falta, el veredicto es "sin datos", nunca el positivo.
2. **La asimetría importa.** Un mínimo (proteína) con datos parciales puede
   darse por cumplido si lo que falta solo puede sumar. Un máximo (calorías)
   con datos parciales NO puede darse por cumplido — y uno ya excedido con lo
   que se sabe, está excedido.
3. **Congelar conserva la ignorancia.** Lo que se persiste (porciones,
   revisiones, órdenes) guarda sus límites no verificables
   (`unverifiable_constraints`), no solo los incumplidos: una porción con el
   techo sin verificar es estructuralmente distinta de una verificada.
4. **Omitir es mentir.** Filtrar un item UNRESOLVED de una lista sin
   declararlo convierte "no sé" en "todo bien". Toda pantalla que filtra
   declara lo que dejó fuera y por qué (contando, no adivinando).
5. **Sin factor no hay conversión.** Entre bases físicas (crudo/cocido,
   porción comestible/empaque) solo convierte un factor ANOTADO
   (`ingredient_yields`, `ingredient_basis_conversions`). El 1:1 implícito
   está prohibido; el faltante resultante se declara.

## Dónde quedó aplicada (evidencia del gate)

| Área (§6) | Antes | Ahora |
|---|---|---|
| Nutrición | `value()` volvía null→0 y el techo pasaba | `unverifiableConstraints` + razón `LIMIT_UNVERIFIABLE`; persistido (0025) y visible en la comida confirmada |
| Techo de calorías | "CUMPLIDO" con energía desconocida | "SIN verificar", chip ámbar en pantalla |
| Rendimiento | 1:1 inventado en prep; «0 g» en compras | prep declara `unresolved`; compras dice "cantidad por confirmar"; delta "+ cantidad por confirmar (nuevo)" |
| Forecast insuficiente | INSUFFICIENT_DATA en el grupo verde "Bien abastecido", razón "cubre el horizonte" sin datos | verde exige `coverage.kind === "DAYS"`; badge "sin datos"; razón bifurcada; /pantry/reorder y Procurement declaran los UNRESOLVED |
| Valor de inventario | — (ya cumplía: costo solo si se puede calcular ENTERO, `wasteCost30` con `every(cost !== null)`) | igual, verificado por la auditoría |

## Cómo se vigila

- `gate-error-contract.test.ts`: ninguna escritura descarta su resultado.
- `gate-fechas.test.ts`: el día UTC no decide vigencias.
- Tests de motores: `optimizer` (unverifiable), `stock/engine` (S-1, razones),
  `prep/engine` (B-2 unresolved), `shopping` (deltas).
- Revisión de diseño: toda feature nueva de Sprint 11 que muestre un veredicto
  debe responder "¿qué pasa si el dato es UNKNOWN?" en su QA.
