# Publicar la app

Hoy la plataforma no existe fuera del disco de Francisco. La única forma
documentada de abrirla es `npm run dev` contra `http://localhost:3000`, así que
las 32 pantallas, las recetas, la despensa y el módulo clínico solo funcionan
mientras alguien esté sentado en ese computador.

Esto no es una funcionalidad que falte: es que el software no está publicado.

Este documento es el camino completo, en orden, con las trampas que ya
conocemos. Leelo entero antes de empezar: hay dos cosas que si se hacen en el
orden equivocado dejan la app rota en producción.

---

## Antes de publicar: dos cosas que no se pueden saltar

### 1. Aplicar las migraciones 0036 y 0038

**Si publicas sin esto, cuatro pantallas quedan rotas el primer día.**

`web/src/app/stock/queries.ts` consulta `meal_serving_record_items`, tabla que
crea la 0036. Esa migración no está aplicada, así que la consulta falla y —bien
hecho, porque ERROR ≠ VACÍO— el código lanza `DataAccessError` en vez de mostrar
una despensa vacía. Las pantallas afectadas son `/pantry`, `/pantry/reorder`,
`/pantry/item/[id]` y `/procurement`.

Las dos migraciones van juntas o no va ninguna: la 0036 le quita a
`consume_planned_meal` el poder de escribir consumo, y la 0038 es quien lo
recupera en el eje nutricional. Aplicar la 0036 sola deja el sistema descontando
la despensa sin que nadie registre lo comido, y ese hueco después se lee como un
cero.

```bash
node scripts/poner-al-dia.mjs --aplicar 0036 0038
```

Verifica antes con `node scripts/poner-al-dia.mjs` a secas: muestra el orden y
no toca nada.

### 2. Elegir la rama, y NO es `main`

`main` tiene **dos archivos**: `README.md` e `index.html`, que son la política de
privacidad de *Entreno*, la app de HIIT para Android. Los 47 commits de esta
plataforma viven en `claude/prompt-maestro-architecture-qkphe1`.

Cualquier hosting que despliegue "la rama por defecto" va a publicar la política
de privacidad de otra app. Hay que decirle explícitamente cuál rama es la de
producción.

Si en algún momento se decide que esta rama pase a ser la principal, el contenido
actual de `main` tiene que mudarse a otra parte primero: es un sitio legal que
está publicado y en uso.

---

## Publicar en Vercel

Es el camino más corto para Next.js 15 con App Router, y no requiere tocar el
código: no hay `vercel.json` a propósito, porque Vercel detecta Next.js solo y un
archivo de configuración de más es una cosa más que se desincroniza.

1. **Importar el repositorio** `ThinkcarChile/entreno-legal`.

2. **Root Directory: `web`.** El repositorio tiene el proyecto Next adentro de esa
   carpeta, no en la raíz. Si se deja en la raíz, el build no encuentra nada.
   Esto se configura en el panel, no en un archivo.

3. **Production Branch: `claude/prompt-maestro-architecture-qkphe1`.** Por lo del
   punto 2 de más arriba.

4. **Variables de entorno**, solo estas dos:

   | variable | de dónde sale |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → Data API |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | la clave *publishable* / anon del mismo panel |

   **`SUPABASE_ACCESS_TOKEN` NO VA ACÁ.** Ese token es de la Management API:
   ejecuta SQL arbitrario sobre cualquier proyecto de la cuenta, incluida la base
   clínica. Solo lo usa `scripts/aplicar-migracion.mjs`, que corre desde un
   computador, nunca desde el servidor web. Por eso vive en `.env.deploy` en la
   raíz del repositorio y no en `web/.env.local`: Next.js carga ese archivo
   entero dentro de `process.env` del servidor.

   Y nada de secretos con prefijo `NEXT_PUBLIC_`: eso Next.js lo incrusta en el
   bundle del navegador. Ya pasó una vez.

5. **Desplegar.** El CI ya corre `lint`, `typecheck`, `test` y `build` en cada
   push a `claude/**`, así que si el build de Vercel falla, el CI debería haberlo
   dicho antes.

---

## Después de publicar: la autenticación

Supabase rechaza los redirects a dominios que no conoce, así que apenas exista la
URL hay que registrarla.

Supabase → Authentication → URL Configuration:

- **Site URL**: la URL de producción de Vercel.
- **Redirect URLs**: agrega la de producción. Si vas a usar los *preview
  deployments* de Vercel (uno por rama), agrega también su patrón — si no, cada
  preview queda sin poder iniciar sesión y parece que la app está rota cuando
  solo falta esta línea.

Deja `http://localhost:3000` en la lista: es lo que permite seguir desarrollando.

---

## Lo primero que hay que probar, en este orden

No sirve "abrir y ver que carga". Estas cinco cosas son las que de verdad prueban
que la publicación quedó bien, y están ordenadas para que cada una use lo que
dejó la anterior:

1. **Iniciar sesión.** Si falla acá, es el paso de autenticación de arriba.
2. **Abrir `/pantry`.** Es la pantalla que depende de la 0036. Si muestra un
   error de acceso a datos, las migraciones no se aplicaron.
3. **Abrir `/plan`** y ver la semana.
4. **Abrir `/health`** desde una cuenta que NO sea la dueña de esa ficha, y
   confirmar que no ve lo que no le toca. Es la única verificación de este
   listado que cubre datos médicos, y es la que más caro sale si falla.
5. **Instalar la app** en un celular Android y abrirla desde el ícono.

---

## Lo que sigue sin estar resuelto, y conviene saberlo antes

- **No hay respaldos** de la base de producción, que ya tiene datos de una
  familia real y datos clínicos. Publicar aumenta el uso, y el uso aumenta lo que
  se pierde si algo pasa.
- **No hay registro de migraciones aplicadas** en ninguna base: la única fuente
  de verdad es `pending-supabase-migrations.md`, escrito a mano.
- **Las 282 recetas no están en producción.** Viven en un seed marcado como de
  desarrollo, porque su nutrición son valores de referencia y no datos del INTA.
  La app va a mostrar el catálogo de 14 recetas hasta que eso se decida.
- **Los permisos por rol están a medias**: invitar a alguien como COOK o como
  PLANNER le da hoy el mismo poder sobre el plan semanal.
