# Auditoría adversarial del cierre de auth

Fecha: **2026-09-05**. Un panel de cuatro atacantes independientes (open redirect,
lógica de flujo, fugas y oráculos, invitación y política de hogar) sobre el diff
de auth, cada hallazgo pasado por un verificador que intentó refutarlo. 17
hallazgos; 9 sobrevivieron a la verificación (8 BAJA, 1 MEDIA), 4 se descartaron,
4 verificadores no cerraron por tope de gasto de la cuenta y esos se juzgaron por
el mérito del análisis del atacante.

## Lo que se arregló en esta ronda

| # | hallazgo | gravedad | qué se hizo |
|---|---|---|---|
| 1 | `/family?error=` y `SinHogar` pintaban texto libre de la URL | BAJA | Familia e invitación ahora usan **códigos de aviso** (`app/family/avisos.ts`), igual que `/login`. La página lee `?aviso=<código>` y resuelve el texto de una lista nuestra; un código desconocido no pinta nada. Verificado en el navegador: `?aviso=<texto de estafa>` no muestra nada |
| 2 | `DemoFamilyButton` visible para todo integrante; su RPC **borra y reescribe** metas y patrones reales | MEDIA | Se esconde en producción tras el mismo interruptor que la creación de hogares (`HOGAR_CREACION_ABIERTA`). Es una ayuda de desarrollo, no algo para la mesa real |
| 3 | El log de `/auth/callback` aceptaba texto elegido por quien arma la URL bajo `codigo` | BAJA | El `error_code` se acota a `^[a-z_]{1,40}$` antes de registrarlo; lo que no calza entra como `otro` |

El vector 1 lo introdujo el propio commit de cierre: movió `/login` a códigos pero
dejó `/family` en texto libre, y el documento de producción afirmaba que "todo
aviso viaja por código". Ahora es cierto. Regresión: `sin-hogar.test.ts` afirma
que ninguna acción de familia ni de invitación emite `?error=` con texto.

## Lo que queda como seguimiento, con su razón

Ninguno bloquea la beta familiar; se dejan escritos para no perderlos.

- **`create_household` sigue llamable por PostgREST** (MEDIA). La política "hogares
  cerrados" vive en el código (página + acción), no en la base: un usuario con
  sesión puede llamar `/rest/v1/rpc/create_household` a mano y crearse un hogar
  igual. Cerrarlo de raíz necesita una migración (revocar el EXECUTE a
  `authenticated` y dárselo por otra vía), y esta ronda no toca migraciones.
  **Riesgo para la beta: bajo** — sólo la familia invitada tiene sesión, y crear
  un hogar de más no expone los datos de nadie (la RLS sigue en pie). Cuando se
  quiera cerrar, va en la misma 0063 que las 12 políticas sin `TO`.

- **`signUp` es un oráculo de correos con Confirm Email apagado** (MEDIA). Hoy, un
  correo ya registrado responde distinto que uno nuevo, y el sondeo negativo deja
  una cuenta con clave del atacante. **Se cierra al activar Confirm Email**, que
  es justo el paso pendiente de `auth-produccion.md`: con confirmación, GoTrue no
  entrega sesión en ninguno de los dos casos y el código sólo mira `data.session`.
  Es una razón más para que Confirm Email esté ON antes de abrir a desconocidos.

- **UX de invitación** (BAJA): aceptar un enlace vencido/usado muestra el
  formulario y recién al enviarlo dice "inválida"; y un integrante que ya está en
  el hogar que acepta otra invitación del mismo hogar recibe el mismo mensaje
  genérico (choca con el índice único y la RPC se revierte). Son molestias, no
  fugas. Follow-up de producto.

- **Copy cruzado** (BAJA): algunas pantallas todavía dicen "crea o únete a un
  hogar" mientras la política es "necesitas una invitación". Alinear el texto.

## Lo que se descartó (el atacante leyó bien el código, la conclusión no se sostuvo)

- **Open redirect por `Host`/`X-Forwarded-Host` sin `SITE_URL`**: el origen
  deducido de cabeceras sólo afecta los enlaces de correo, y esos los frena la
  allowlist de Redirect URLs de Supabase (obligatoria en `auth-produccion.md`).
  El redirect del callback no puede ser sacado del sitio por el `Host`.
- **Dejar viva la sesión de recuperación si `updateUser` falla**: la rama de
  fallo deja la sesión **exactamente como estaba**; no amplía ni alarga ningún
  acceso, y permite reintentar la clave, que es lo correcto.
- Dos teorías más sobre el flujo de `?code=` que resultaron inalcanzables o sin
  nada que ganar.
