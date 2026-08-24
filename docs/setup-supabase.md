# Activar Supabase (paso a paso)

Guía para dejar el proyecto corriendo de verdad en el navegador. Son ~10 minutos.
La app usa **email + contraseña** (`signInWithPassword` / `signUp`), no magic link.

---

## 1. Crear el proyecto

1. Entra a <https://supabase.com/dashboard> con tu cuenta.
2. **New project**.
   - **Name**: `mesa-familiar` (o el que quieras).
   - **Database password**: genera una fuerte y **guárdala en tu gestor de contraseñas**.
     No la necesitas para la app, sí para conectarte por `psql` o para restaurar.
   - **Region**: **South America (São Paulo)** — es la más cercana a Chile.
   - **Plan**: Free alcanza y sobra para esto.
3. Espera ~2 minutos a que termine de aprovisionar.

## 2. Copiar las credenciales

En **Project Settings → API**:

- **Project URL** → `https://xxxxxxxxxxxx.supabase.co`
- **Project API keys → `anon` / `public`** → un JWT largo.

> La `anon key` es **pública por diseño** (viaja al navegador); quien protege los datos es la RLS.
> La **`service_role` key NO se usa en este proyecto y no debe salir del dashboard** — se salta toda la RLS.

## 3. Crear `web/.env.local`

En `C:\Users\franc\entreno-legal\web`, crea el archivo `.env.local`:

```
NEXT_PUBLIC_SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOi...
```

`.env.local` ya está en `.gitignore`: no se sube al repo.

## 4. Aplicar las migraciones

En el dashboard: **SQL Editor → New query**. Pega y ejecuta **en este orden**, una por una,
esperando el "Success" de cada una:

1. `supabase/migrations/0001_family.sql`
2. `supabase/migrations/0002_catalog.sql`
3. `supabase/migrations/0003_recipes.sql`

> Orden obligatorio: cada una depende de la anterior. Si una falla, **no sigas** —
> avísame con el mensaje de error en vez de saltártela.

## 5. Cargar los seeds de desarrollo (opcional pero recomendado)

Mismo SQL Editor, después de las migraciones:

1. `supabase/seed/dev_catalog_seed.sql` — ~19 ingredientes y 3 productos.
2. `supabase/seed/dev_recipes_seed.sql` — 8 recetas de demostración.

Todo entra marcado `DEV_SEED`: valores plausibles para validar la arquitectura,
**nunca** se muestran como datos oficiales ni verificados.

## 6. Ajustar autenticación

En **Authentication → Providers → Email**: debe estar habilitado (lo está por defecto).

En **Authentication → Sign In / Providers** (o **Settings**), busca **Confirm email**:

- **Desactívalo mientras desarrollamos.** Si queda activo, al registrarte Supabase no te
  entrega sesión hasta que hagas clic en un correo de confirmación, y la app te va a
  devolver al login como si la clave estuviera mala.
- Antes de que esto lo use gente de verdad, se vuelve a activar.

En **Authentication → URL Configuration**, agrega a **Redirect URLs**:

```
http://localhost:3000/**
```

## 7. Levantar la app

```bash
cd C:\Users\franc\entreno-legal\web && npm run dev
```

Abre <http://localhost:3000>:

1. **Crear cuenta** con tu correo y una contraseña.
2. Te lleva a **Familia** → crea el hogar (nombre del hogar + tu nombre).
3. **Catálogo** → deberías ver los ingredientes del seed.
4. **Recetas** → las 8 recetas de demostración.

---

## Si algo falla

| Síntoma | Causa casi siempre |
|---|---|
| `Supabase no está configurado` | Falta `web/.env.local`, o no reiniciaste `npm run dev` después de crearlo. |
| "Credenciales incorrectas" recién registrado | **Confirm email** sigue activo (paso 6). |
| Catálogo vacío pero sin error | Faltan los seeds (paso 5), o los corriste antes de las migraciones. |
| `relation "households" does not exist` | Migraciones aplicadas fuera de orden o alguna falló a la mitad. |
| Ves 0 recetas teniendo seed | Estás en un hogar distinto al del seed: el seed carga recetas **globales**, que sí deberían verse. Si no, avísame: es un problema de RLS y quiero verlo. |

Las variables de entorno de Next se leen **al arrancar**: cada vez que toques `.env.local`,
corta el `npm run dev` y vuelve a levantarlo.
