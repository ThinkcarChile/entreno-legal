# ADRs — Architecture Decision Records

Desde el congelamiento de la [ARCHITECTURE BASELINE 1.0](../architecture/BASELINE.md), todo cambio estructural importante se documenta aquí antes de implementarse.

Formato: `NNNN-titulo-corto.md`, correlativo. Plantilla:

```markdown
# NNNN — Título

- Estado: PROPUESTO | APROBADO | RECHAZADO | SUPERSEDED por NNNN
- Fecha:
- Decisión de baseline afectada: (K-x / documento / ninguna)

## Contexto
## Decisión
## Consecuencias (incluye migración requerida)
```

## ADRs registrados

| # | Título | Estado |
|---|---|---|
| [0001](./0001-food-data-provenance.md) | Food Data Provenance | APROBADO (Sprint 2) |
| [0002](./0002-recipe-versioning-and-nutrition-aggregation.md) | Versionado de recetas y agregación nutricional | APROBADO (Sprint 3) |
| [0003](./0003-portion-optimizer-and-member-profiles.md) | Perfiles nutricionales y PortionOptimizer | APROBADO (Sprint 4) |
| [0004](./0004-explicit-component-roles.md) | El rol culinario de un componente se declara, no se infiere | APROBADO (QA Sprint 4) |
| [0005](./0005-confirmed-servings-share-the-projection-table.md) | La porción confirmada es la misma proyección, con asignación | APROBADO (Sprint 5) |
| [0006](./0006-participantes-y-ciclo-de-vida-de-la-porcion.md) | Participantes por comida y ciclo de vida de una porción | APROBADO (QA Sprint 5) |
| [0007](./0007-shopping-engine.md) | ShoppingEngine: la lista de compras sale de las porciones confirmadas | APROBADO (Sprint 6) |
| [0008](./0008-inventario-por-lotes.md) | Despensa: lotes con libro mayor append-only | APROBADO (Sprint 7) |
