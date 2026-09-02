# ADR 0013 — Gasto de caja != consumo económico

**Estado:** ACEPTADA · **Sprint:** 14 · **Fecha:** 2026-09-01

## Contexto

Compro hoy 5 kg de pollo por $25.000. El gasto de caja de hoy es $25.000. Si
esta semana consumimos 2 kg, el consumo económico es ~$10.000: los otros
$15.000 siguen siendo **valor almacenado** en la despensa.

Registrar toda compra como gasto consumido de inmediato es el error que este
sprint existe para evitar. Produce dos mentiras simétricas y las dos empujan a
decisiones equivocadas: el hogar que hace la compra grande del mes aparece
gastando de más sin haber comido nada, y el que se está comiendo una despensa
llena aparece gastando cero mientras liquida $200.000 de inventario.

## Decisión 1 — Tres cifras separadas, siempre

El panel del hogar muestra **CAJA**, **CONSUMO ECONÓMICO** y **VALOR
ALMACENADO** como tres números distintos, nunca uno derivado en la cabeza de
quien mira.

    Salió del bolsillo (caja)        — public.purchase_cash_summary
    De eso, quedó en la despensa     — capitalized
    Gasto que no queda en la despensa— expensed_only (despacho, propina, redondeo)
    Se consumió de verdad            — cost_allocations, por categoría
    Tu despensa vale hoy             — public.pantry_value  (SALDO)
    Este mes guardaste               — storedValueDelta      (VARIACIÓN)

**`storedValueDelta = capitalizado − salidas de despensa`**, y NUNCA
`caja − consumo`. La caja incluye cargos `EXPENSE_ONLY` que por definición no
capitalizan; restarle el consumo a la caja completa infla la cifra insignia del
sprint todos los meses por exactamente el monto del despacho.

Saldo y variación son **dos filas rotuladas distinto**. «Valor guardado en la
despensa +$45.820» se lee como «mi despensa vale $45.820», y no era ni una cosa
ni la otra.

## Decisión 2 — El desconocido tiene tipo, y no es cero

`MoneyOrUnknown` no tiene rama `null`: el desconocido viaja **siempre con su
motivo** (`money_unknown_reason`). Tres cosas distintas que el tipo separa:

| Situación | Representación |
|---|---|
| «me lo regalaron» | `{ known: true, amount: 0 }` — un cero de verdad |
| «no sé cuánto costó» | `{ known: false, reason: LOT_VALUE_UNKNOWN }` |
| «la consulta falló» | `DataAccessError`, jamás un valor |
| «no tienes permiso» | estado `SIN_PERMISO` (ver Decisión 5) |

`<Monto>` es el único componente que pinta plata y tiene esas cuatro ramas.
`app.sum_money` devuelve un compuesto con `unknown_count`: no hay forma de
sacar un total sin decidir qué hacer con lo que falta.

## Decisión 3 — El período contable cierra por `recognized_on`

`cost_allocations` guarda `occurred_on` (cuándo pasó) y `recognized_on` (cuándo
se supo). **El período cierra por `recognized_on`.**

Si cerrara por `occurred_on`, una corrección insertada en septiembre con fecha
de julio cambiaría el informe de julio la próxima vez que se abriera: el
«$48.320 que pasó a ser $51.900». Un informe que cambia solo no es un informe.

`occurred_on` queda como desglose informativo —«de lo que aparece en
septiembre, $3.200 ocurrió en agosto»— en `public.late_recognition_report`.
Toda vista que agrupe por `occurred_on` se marca como «puede cambiar con
reconocimientos tardíos» y **jamás alimenta el semáforo de presupuesto**.

## Decisión 4 — El costo se congela en el movimiento

Cuando el ledger registra un consumo, `app.allocate_movement_cost` atribuye el
costo **desde el lote** y lo **congela en la asignación** junto con su
`cost_basis_snapshot` y su `engine_version`. No se recalcula historia hacia
atrás: cambiar un precio hoy no cambia lo que costó un consumo de la semana
pasada, y la despensa **no se revaloriza a precio de mercado** — vale lo que
costó.

Corolario en el motor de recetas: la valorización de lo que está en la despensa
es `LOT_ACTUAL` y **nada más**. Si el lote existe pero su valor es desconocido,
la línea queda desconocida; no cae a «último precio» ni a una observación de
vitrina. Ese fallback era la puerta por la que la inflación de alimentos se
convertía en un «ahorro» del hogar que nunca existió. Los precios de mercado
sólo valorizan **lo que hay que salir a comprar**, que es caja futura.

Y «ya lo tengo» no significa «es gratis»: lo que está en la despensa suma al
costo de preparar y no suma a lo que hay que comprar. Las dos cifras se muestran
juntas y rotuladas.

## Decisión 5 — El dinero del hogar tiene permisos propios

`public.finance_permission` con seis valores y `household_finance_grants` con
**dimensión de dueño**, calcado de `medical_data_grants`:

- `FINANCE_VIEW` — agregados del hogar.
- `FINANCE_VIEW_MEMBER` — **el desglose por integrante**, con dueño.
- `FINANCE_UPLOAD_RECEIPTS` / `FINANCE_CONFIRM_RECEIPTS` / `FINANCE_MANAGE_PRICES` /
  `FINANCE_MANAGE_BUDGET`.

Lo que ya era público dentro del hogar era **qué** comió cada uno. Ponerle
**precio** a una persona es una capacidad nueva de este sprint y nace con
control: ninguna consulta, vista ni componente del producto ordena, rankea o
compara integrantes por monto.

`inventory_lots.value_minor` se cierra **a nivel de columna** (la despensa sigue
visible entera para todos: cantidades, vencimientos, ubicación) y el dinero se
lee sólo por `public.lot_valuations`.

Y el corolario de interfaz: **una consulta sin permiso devuelve cero filas, no
un error**. Un loader que suma cero filas pinta «$0 gastado», indistinguible de
un hogar que no gastó nada, y el test que vigila `DataAccessError` no lo ve. Por
eso los cargadores financieros resuelven el permiso **explícitamente**
(`public.finance_permissions`) antes de consultar y devuelven un estado tipado.

## Decisión 6 — El presupuesto declara sobre qué mide

`household_food_budgets.basis` es `NOT NULL` y sin default: `CASH` o
`ECONOMIC_CONSUMPTION`. Si el hogar fija los dos, la pantalla muestra **dos
semáforos**, nunca uno promediado, y el copy nombra el lado.

`ON_TRACK` es **inalcanzable con cobertura mala**: con confianza `PARTIAL` o
`INSUFFICIENT_DATA` el estado es `UNKNOWN_COVERAGE`, un color propio, ni verde ni
rojo. Un semáforo verde calculado sobre la mitad de los precios le da permiso a
la persona para gastar sobre una base falsa. `OVER` sí se declara aunque falten
datos: si lo conocido ya superó el presupuesto, se pasó, punto.

Un presupuesto rige **desde el próximo período completo**: cambiarlo hoy no
mueve el mes en curso ni ninguno cerrado.

## Decisión 7 — El OCR no toca nada hasta que un humano confirma

La extracción de boletas produce **candidatos**. No crea stock, no crea precios,
no mueve plata. Es la misma frontera del Sprint 11 entre IA y motor clínico,
aplicada al dinero.

## Decisión 8 — Las finanzas nunca pasan por encima de la seguridad alimentaria

`web/src/domain/finance/**` no importa `domain/clinical/**` (lo vigila el test
de regex del Sprint 11), pero eso prueba que los módulos no se hablan, no que el
producto no anteponga la plata. Además, y como regla de producto:

- Ninguna pantalla de dinero renderiza una acción «consumir» o «cocinar» sobre
  un lote fuera de la ventana segura. El costo de la merma se muestra como
  **hecho consumado**, jamás como llamado a la acción: poner «$5.900 evitable»
  al lado de un lote por vencer es empujar a comerse algo que
  `FoodStorageSafetyEngine` ya condenó.
- El comparador de precios sólo ordena **dentro** de una lista ya filtrada por
  el motor clínico. El producto más barato incompatible no existe para este
  módulo: no entra al input.

## Consecuencias

- Migraciones 0042–0048. `inventory_lots` gana `value_minor` entero y su moneda
  congelada; nace `cost_allocations` como puente entre el ledger y el dinero.
- Motores puros nuevos: `money`, `confidence`, `recipe-cost-engine`,
  `forecast-engine`. Ninguno tiene reloj, red ni base.
- Guardas de CI: `finanzas-invariantes.test.ts` prohíbe `?? 0`, `|| 0`,
  `toFixed(`, `z.coerce.number()`, `coalesce(x_minor, 0)`, `sum(x_minor)` y
  `greatest(monto, 0)` en todo archivo que toque plata, de los dos lados.
- Lo que **no** hace este sprint: bancos, tarjetas, deudas ni contabilidad
  tributaria.
