# 0001 — Food Data Provenance

- Estado: APROBADO (implementado en Sprint 2)
- Fecha: 2026-08-24
- Decisión de baseline afectada: desarrolla K-4 (base canónica) y el principio "la IA nunca inventa nutrición" (Sprint 0 §C-3, F). No modifica la baseline.

## Contexto

Todo el sistema (porciones, macros, compras, motor clínico) se apoya en datos nutricionales. Necesitamos saber siempre de dónde salió cada número, distinguir dato oficial de dato de usuario, y nunca confundir "desconocido" con "cero".

## Decisión

### 1. Jerarquía de fuentes (`source_type`, de mayor a menor confianza)

1. `PACKAGE_LABEL_VERIFIED` — etiqueta real verificada por revisión.
2. `NATIONAL_FOOD_DATABASE` — base nacional (para Chile: Tabla de Composición de Alimentos INTA/U. de Chile 2018, **sujeta a verificación de licencia antes de cualquier importación**).
3. `USDA_FOODDATA_CENTRAL` — dominio público, fuente complementaria.
4. `OTHER_VERIFIED_DATABASE`
5. `USER_ENTERED_LABEL` — etiqueta tipeada por el usuario (con confirmación previa al guardado).
6. `USER_ENTERED_GENERIC` — estimación genérica del usuario.
7. `AI_ESTIMATE` — **nunca se presenta como dato verificado**; siempre marcada y confirmable.
8. `DEV_SEED` — datos de desarrollo/demostración: valores plausibles para validar arquitectura, **explícitamente no oficiales**, `verified=false`, excluibles de producción.

Cuando existen varias entradas para el mismo alimento+estado, la aplicación muestra por defecto la de mayor jerarquía; las demás quedan consultables.

### 2. Procedencia inmutable

Toda fila de `nutrition_facts` conserva: `source_type`, `source_name`, `source_record_id`, `source_version`, `source_date`, `verified`, `verified_at`, `verification_method`, `notes`. Copiar o normalizar datos **jamás reescribe el origen**: una normalización produce una fila nueva que apunta a la misma fuente, o mantiene la fila con sus valores originales adjuntos.

### 3. Base canónica y valores originales

- Sólidos: **por 100 g**; líquidos: **por 100 ml** (`basis_unit` G|ML).
- El estado del alimento (`weight_basis`: RAW/COOKED/DRAINED/EDIBLE_PORTION/AS_PACKAGED) es parte de la identidad de la entrada. 100 g crudo ≠ 100 g cocido; el dominio **rechaza** combinar bases distintas.
- Cuando el dato llega "por porción" (48 g = 90 kcal), se normaliza a 100 (187,5 kcal/100 g) **y se conservan** `original_serving_quantity`, `original_serving_unit` y los valores originales de etiqueta (`original_values`). Nunca se pierde el dato original.

### 4. UNKNOWN ≠ ZERO (regla crítica)

Un nutriente que la fuente no informa se guarda como **NULL**, jamás como 0. Los cálculos propagan NULL ("desconocido") y la UI lo muestra como "—/sin dato". Imprescindible para el futuro motor clínico (un potasio "0" falso es un dato clínico peligroso).

### 5. Ingredient vs CommercialProduct

- `ingredients` (genéricos, sin marca): globales (`household_id NULL`, curados, solo lectura para hogares) o privados del hogar.
- `commercial_products` (marca, barcode, envase, porción): privados del hogar por defecto. La promoción de un producto privado al catálogo global requiere proceso explícito futuro (curación); nunca es automática.
- Barcode: validado por checksum GS1 (EAN-8/UPC-A/EAN-13/GTIN-14), único **por ámbito** (global o por hogar).

### 6. Fuentes externas y licencias (política futura)

- **INTA 2018**: prioritaria conceptualmente para el hogar chileno; **no se importa** sin comprobar disponibilidad/licencia de reutilización. Proceso futuro: verificar licencia → importar con `source_record_id` por alimento → `verification_method='LICENSED_IMPORT'`.
- **USDA FoodData Central**: dominio público; se integrará vía `FoodDataProvider` (interfaz `search`/`getFood`/`mapNutrition`), sin acoplar UI al proveedor.
- **Open Food Facts**: solo consulta futura de productos por barcode vía `BarcodeProductProvider`, respetando ODbL (atribución y share-alike sobre lo derivado); **sin importación masiva** y sin acoplar la base interna a su esquema.
- La arquitectura es multi-fuente por diseño: ningún componente depende de una fuente concreta.

### 7. Precisión numérica

- **PostgreSQL**: `numeric` en todo dato nutricional/cantidad — nutrientes por 100 como `numeric(10,3)`, cantidades como `numeric(10,2)`. Sin float en almacenamiento.
- **Dominio TS**: los cálculos por cantidad usan `number` (doble precisión) — operaciones simples de escala sin acumulación iterativa, error despreciable frente a la incertidumbre nutricional real. **No se redondea internamente**: el redondeo ocurre solo (a) en el borde de persistencia (3 decimales, half-up) y (b) en la UI para visualización.
- Sumas financieras/inventario (sprints posteriores) mantienen la estrategia de la baseline: `numeric` en DB, valores totales (no unitarios) como canónicos.

## Consecuencias

- Tabla única `nutrition_facts` para ingredientes y productos, con procedencia completa y nullabilidad honesta.
- Los seeds de desarrollo son inconfundibles con datos oficiales (`DEV_SEED`).
- Cambiar/agregar proveedor externo no toca UI ni dominio (interfaces `FoodDataProvider` / `BarcodeProductProvider`).
