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

## Qué incluye el Sprint 1

- Next.js 15 (App Router) + TypeScript strict + Tailwind 4, PWA shell mobile-first.
- Auth email+contraseña (Supabase Auth) con refresh de sesión en middleware.
- Dominio Family: hogares, integrantes (con o sin cuenta), roles semilla (ADMIN/MEMBER/PLANNER/SHOPPER/COOK), permisos por unión de roles.
- Invitaciones por link de un solo uso (hash SHA-256 almacenado, TTL 7 días) para unirse o vincular un miembro sin cuenta.
- Pantalla FAMILIA mínima: crear hogar, listar integrantes con roles, generar invitación.
- Outbox (`domain_events` con `dedupe_key`) y auditoría append-only, listos para los sprints siguientes.
