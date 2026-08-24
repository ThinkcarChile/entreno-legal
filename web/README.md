# Mesa Familiar — aplicación web

Sprint 1 (Fundaciones) de la [Plataforma Familiar Inteligente de Alimentación](../docs/sprint-0/README.md). Arquitectura: [BASELINE 1.0](../docs/architecture/BASELINE.md).

## Desarrollo

```bash
cd web
cp .env.example .env.local   # completar con URL y anon key del proyecto Supabase
npm install
npm run dev
```

Migraciones: aplicar `../supabase/migrations/*.sql` al proyecto Supabase (SQL editor o `supabase db push`). RLS queda activa en todas las tablas; la creación de hogar y la aceptación de invitaciones van por funciones `security definer` (`create_household`, `accept_invitation`).

## Checks

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

## Tests de base de datos

`scripts/db-test.sh` levanta un PostgreSQL local efímero, aplica `supabase/migrations/*.sql` + el seed de desarrollo y ejecuta `supabase/tests/rls_catalog.sql` (aislamiento RLS entre hogares, barcode único por ámbito, UNKNOWN ≠ ZERO, DEV_SEED nunca verificado). Corre también en CI.

## Qué incluye el Sprint 2

- Catálogo nutricional multi-fuente ([ADR 0001](../docs/adr/0001-food-data-provenance.md)): ingredientes genéricos globales/privados, productos comerciales del hogar, nutrición por 100 g/ml con estado (crudo/cocido/…), procedencia completa y **nutrientes desconocidos como NULL, nunca 0**.
- Seed de desarrollo (~19 ingredientes + 3 productos demo, `source=DEV_SEED`, explícitamente no oficial).
- Dominio puro testeado: normalización etiqueta→100 g (conservando el original), cálculo por cantidad, porciones con peso real prioritario, no-mezcla crudo/cocido ni g/ml, validación GS1 de barcodes (EAN-8/UPC-A/EAN-13/GTIN-14).
- Pantallas: CATÁLOGO (búsqueda por nombre/marca/barcode + filtros), detalle de ingrediente y de producto con calculadora inmediata, AGREGAR PRODUCTO con resumen de confirmación ("Interpretamos: …").
- Abstracciones `FoodDataProvider` / `BarcodeProductProvider` para USDA y Open Food Facts futuros (sin implementación productiva).

## Qué incluye el Sprint 1

- Next.js 15 (App Router) + TypeScript strict + Tailwind 4, PWA shell mobile-first.
- Auth email+contraseña (Supabase Auth) con refresh de sesión en middleware.
- Dominio Family: hogares, integrantes (con o sin cuenta), roles semilla (ADMIN/MEMBER/PLANNER/SHOPPER/COOK), permisos por unión de roles.
- Invitaciones por link de un solo uso (hash SHA-256 almacenado, TTL 7 días) para unirse o vincular un miembro sin cuenta.
- Pantalla FAMILIA mínima: crear hogar, listar integrantes con roles, generar invitación.
- Outbox (`domain_events` con `dedupe_key`) y auditoría append-only, listos para los sprints siguientes.
