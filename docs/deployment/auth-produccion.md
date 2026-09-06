# Auth en producción: lo que el código ya sabe hacer y lo que falta configurar

Corte: **2026-09-05**. El código de esta página está escrito, probado y en `main`
de la rama de producción. **Nada de lo que sigue está configurado en Supabase
todavía**, a propósito: hasta que no haya dominio final, `site_url` sigue en
`localhost:3000`, las Redirect URLs siguen vacías y Confirm Email sigue apagado.

## Qué hay en el código

| superficie | ruta | qué hace |
|---|---|---|
| entrar | `/login` → `signIn` | `signInWithPassword`; todo error → un solo aviso |
| crear cuenta | `/login` → `signUp` | `signUp` con `emailRedirectTo` a `/auth/callback?next=…`; sin sesión → «revisa tu correo» |
| salir | `signOut` | cierra en Supabase y manda a `/login` |
| vuelta del correo | `/auth/callback` | canjea `?code=` (`exchangeCodeForSession`) o `?token_hash=&type=` (`verifyOtp`); redirige a un destino interno |
| olvidé mi contraseña | `/recuperar` | `resetPasswordForEmail` con `redirectTo` a `/auth/callback?next=/nueva-contrasena`; misma respuesta exista o no el correo |
| clave nueva | `/nueva-contrasena` | sólo con sesión de recuperación reciente (`amr: recovery`, 30 min); `updateUser`, cierra sesión, manda a entrar |
| invitación | `/invite/<token>` | sin sesión → `/login?next=/invite/<token>`; con sesión → `accept_invitation` |
| cuenta sin hogar | `/family` | estado controlado: «necesitas una invitación». No crea hogar |

Todo `?next=` pasa por **un solo** validador, `lib/auth/destino.ts`. Todo aviso
viaja por la URL como **código**, y el texto lo pone la página
(`lib/auth/avisos.ts`).

### Política de la beta: se entra por invitación

Supabase permite crear cuentas. Lo que el código decide es que **una cuenta sin
hogar no puede crearse uno**: ve un estado controlado y nada más. La familia ya
tiene su hogar; los que faltan entran con un enlace que genera el administrador
desde `/family`. `HOGAR_CREACION_ABIERTA=1` vuelve a abrir el formulario (para
desarrollo, o el día que haga falta un hogar nuevo).

Con Confirm Email apagado, cualquiera con la URL puede crear una cuenta y ver
ese estado controlado. No ve datos de nadie. Es basura en `auth.users`, no una
brecha — y se cierra activando Confirm Email cuando haya dominio.

## Variables de entorno nuevas

| variable | para qué | producción |
|---|---|---|
| `SITE_URL` | base de los enlaces que salen por correo y del enlace de invitación. Se lee en tiempo de ejecución: cambiar de dominio no obliga a recompilar | **ponerla**, sin barra final. Sin ella se deduce del `Host`, que un proxy puede mentir |
| `HOGAR_CREACION_ABIERTA` | `1` abre la creación de hogares | **no ponerla** |

## Lo que hay que configurar en Supabase, en este orden

Todo en el dashboard del proyecto `smwyxfnlxoohenhsdcjx`, sección
**Authentication**. Se hace **después** de tener el dominio, y **antes** de
activar Confirm Email.

### 1. URL Configuration

- **Site URL**: `https://<DOMINIO>` — sin barra final. Es a donde vuelven los
  correos cuando no se les dio otra cosa; hoy dice `http://localhost:3000`.
- **Redirect URLs** (una por línea):

  ```
  https://<DOMINIO>/auth/callback
  https://<DOMINIO>/auth/callback?next=*
  https://<DOMINIO>/auth/callback?next=**
  ```

  El código manda `emailRedirectTo` / `redirectTo` con `?next=` adentro, y
  Supabase sólo acepta redirecciones que calcen con esta lista. Sin la tercera
  línea, un `next` con `/` codificado (`%2Finvite%2F…`) no calza. Mantener
  también `http://localhost:3000/**` mientras se desarrolle en local.

### 2. Plantillas de correo (recomendado, no obligatorio)

Con las plantillas por omisión el enlace vuelve con `?code=` y el canje **sólo
funciona en el mismo navegador** que pidió el correo (PKCE guarda un verificador
en una cookie). Si alguien se registra en el computador y abre el correo en el
teléfono, el enlace falla con «enlace inválido».

Para que funcione en cualquier dispositivo, en **Email Templates** cambiar el
enlace de **Confirm signup** y de **Reset password** por:

```
{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=email
{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=recovery
```

`/auth/callback` acepta las dos formas. No hay que tocar nada en el código.

### 3. Activar Confirm Email

**Authentication → Sign In / Providers → Email → Confirm email: ON.**

Sólo después de 1 (y de 2 si se quiere). Activarlo antes deja a la gente sin
poder terminar de registrarse: el correo vuelve a `localhost` o a una URL que
Supabase rechaza.

### 4. Probar con una cuenta sintética

Una cuenta nueva con un correo que se pueda leer, en este orden:

1. `/login` → Crear cuenta → debe decir «te mandamos un enlace».
2. Abrir el correo → debe aterrizar en `/` con sesión.
3. Cerrar sesión → `/recuperar` → el correo → `/nueva-contrasena` → clave nueva
   → «tu clave quedó actualizada» → entrar con la nueva.
4. Con un admin del hogar: `/family` → Generar invitación → abrir el enlace con
   la cuenta sintética → «Unirme al hogar» → debe aparecer en la lista.
5. Borrar la cuenta sintética desde **Authentication → Users**.

## Lo que NO se hace desde el código

- No se desactiva el registro en Supabase: la política es «sin invitación no hay
  hogar», que es más simple y no depende de una configuración que alguien puede
  olvidar.
- No se inventan tokens propios para nada de esto: `code`, `token_hash` y `amr`
  son de Supabase.
- No se manda ningún correo desde la app: los manda Supabase.


## Nota del despliegue real (2026-09-06)

Desplegada en Vercel (Hobby, equipo `app comida`) en
**https://mesa-familiar-ten.vercel.app**. Site URL y Redirect URLs de Supabase ya
apuntan ahí. Dos cosas que el despliegue real enseñó:

1. **`amr` de recuperación es `otp`, no `recovery`.** Al canjear el enlace con
   `verifyOtp({type:"recovery"})`, Supabase emite la sesión con
   `amr:[{method:"otp"}]`. La guarda de `/nueva-contrasena` buscaba `"recovery"`
   y rechazaba TODA recuperación legítima. Corregido en `lib/auth/recuperacion.ts`.
   Como la app no usa magic link para entrar, `otp` sólo puede venir del enlace
   de recuperación.

2. **Vercel Deployment Protection.** Un proyecto nuevo nace con `ssoProtection`
   activa, que pone el login de Vercel delante de toda URL `.vercel.app`. Para un
   dominio público hay que apagarla (hecho); la seguridad real es Supabase Auth +
   RLS.

Callback, confirmación (token_hash) y recuperación validados end-to-end contra la
URL real con enlaces de administración y un cambio de clave completo. Falta sólo
la prueba de correo REAL: ver el SMTP abajo.
