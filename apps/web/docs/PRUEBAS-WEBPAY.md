# Pruebas contra Webpay Integration

Guion para ejecutar, desde un computador con salida a Transbank, las diecisiete
pruebas que aquí no se pudieron hacer. El cortafuegos de Transbank (Imperva)
responde 403 a las direcciones de centros de datos, así que **ninguna
transacción real se creó desde el entorno de desarrollo**; ver `TRANSBANK.md`
§12.

Esto no es una lista de deseos: cada prueba dice qué hacer, qué tiene que
verse, qué tiene que quedar en la base y cómo capturarlo.

> **Nunca una tarjeta real. Nunca credenciales productivas. Nunca
> `TRANSBANK_PRODUCTION_ENABLED`.** Las tres cosas están además bloqueadas por
> las guardas, pero conviene decirlo.

---

## 1. Lo que hace falta

| | |
|---|---|
| Red | que alcance `webpay3gint.transbank.cl` (una conexión doméstica sirve; una VPN de centro de datos, no) |
| Node | el del proyecto |
| Supabase | el proyecto de desarrollo, con las migraciones al día |
| Tiempo | unas dos horas y media, con la prueba del tiempo agotado corriendo aparte |

Comprobar primero que las migraciones estén aplicadas:

```bash
npm run db:push:hosted -- --plan     # no escribe nada, dice qué falta
npm run db:push:hosted               # si falta alguna
```

---

## 2. Preparación

### 2.1 Variables

En `apps/web/.env.local`, junto a las de Supabase que ya están:

```bash
PAYMENT_PROVIDER=transbank
TRANSBANK_ENVIRONMENT=integration
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

No se configura código de comercio ni llave: en integración los trae el SDK,
a propósito, para que nadie los confunda con los de verdad.

**No** se añade `TRANSBANK_PRODUCTION_ENABLED`, ni
`TRANSBANK_PRODUCTION_COMMERCE_CODE`, ni `TRANSBANK_PRODUCTION_API_KEY_SECRET`.

### 2.2 Levantar y comprobar el ambiente

```bash
npm run dev
```

Entrar como cliente e ir a pagar un trabajo. **Antes de pulsar nada**, la
pantalla de pago tiene que decir que está en ambiente de integración. Si no lo
dice, parar: se está hablando con otro sitio.

### 2.3 Ensayo en seco (opcional, 10 minutos)

Antes de gastar transacciones reales conviene recorrer el circuito completo con
el proveedor simulado, que implementa la misma interfaz:

```bash
PAYMENT_PROVIDER=mock npm run dev
# ...recorrido...
npm run evidence:webpay -- --ambiente mock --caso "Ensayo" --sin-archivo
```

Así se aprende a leer el informe sin tocar Transbank.

---

## 3. Cómo se comprueba cada prueba

Después de **cada** prueba, una orden:

```bash
npm run evidence:webpay -- --caso "3. Crédito aprobado"
```

Toma el último pago de integración —o el que se le diga con `--orden`— y
escribe en `evidencia/webpay-integration.md` las doce comprobaciones pedidas:

| # | Qué mira | Dónde sale en el informe |
|---|---|---|
| 1 | fila de `payments` | §1 |
| 2 | `buy_order` (formato y longitud) | §1 y §2 |
| 3 | importe | §1 |
| 4 | estado del proveedor | §1 |
| 5 | estado interno | §1 |
| 6 | `payment_events` | §3 |
| 7 | `audit_logs` | §4 |
| 8 | trabajo | §5 |
| 9 | asignación | §5 |
| 10 | payout | §6 |
| 11 | notificaciones | §7 |
| 12 | invariantes | §8 |

**Si algún invariante está roto, la orden termina con error.** Una prueba con
el dinero descuadrado no se da por buena aunque la pantalla dijera lo correcto.

### Lo que nunca aparece, ni en pantalla ni en el archivo

- el token completo: solo los seis primeros caracteres y los cuatro últimos;
- claves de Supabase, de Transbank ni de nada;
- números de tarjeta: de la base solo salen los cuatro últimos dígitos, que es
  lo único que se guarda;
- cookies ni JWT;
- correos, RUT ni teléfonos: las personas salen por su papel.

Al pegar capturas en un correo o en un formulario, **tapar la barra de
direcciones si lleva el token** (`/pagos/retorno?token_ws=…`).

---

## 4. Las tarjetas de prueba

De la documentación oficial de Transbank. Fecha de expiración: cualquiera
futura. Autenticación bancaria: RUT **11.111.111-1**, clave **123**.

| Tarjeta | Número | CVV | Resultado |
|---|---|---|---|
| VISA (crédito) | 4051 8856 0044 6623 | 123 | aprobada |
| AMEX (crédito) | 3700 0000 0002 032 | 1234 | aprobada |
| MASTERCARD (crédito) | 5186 0595 5959 0568 | 123 | rechazada |
| Redcompra (débito) | 4051 8842 3993 7763 | — | aprobada |
| Redcompra (débito) | 4511 3466 6003 7060 | — | aprobada |
| Redcompra (débito) | 5186 0085 4123 3829 | — | rechazada |
| Prepago VISA | 4051 8860 0005 6590 | 123 | aprobada |
| Prepago MASTERCARD | 5186 1741 1062 9480 | 123 | rechazada |

---

## 5. Las diecisiete pruebas

Cada una necesita un trabajo con oferta aceptada y pago pendiente. Conviene
preparar varios antes de empezar: publicar, ofertar desde la cuenta del
trabajador y aceptar desde la del cliente.

### 1. Crear la transacción

**Qué**: pulsar «Pagar con Webpay» y no seguir.

Tiene que verse la página de transición y después el formulario de Webpay en
`webpay3gint.transbank.cl`.

Esperado en la base: `payments.status = CREATED`, con `buy_order` de 26
caracteres, `session_id`, `return_url` apuntando a
`http://localhost:3000/pagos/retorno`, `redirect_url` de Transbank y token
guardado. Sin payout. El trabajo sigue en `PAYMENT_PENDING`.

```bash
npm run evidence:webpay -- --caso "1. Crear la transacción"
```

### 2. Consultar el estado de esa transacción

**Qué**: sin pagar, ir a `/admin/pagos` y pulsar «Consultar al proveedor» sobre
el pago anterior.

Esperado: Webpay contesta `INITIALIZED`. El pago **sigue en la cola**, no se
asienta, no se crea payout y el estado interno no cambia. Esto es exactamente
lo que corregimos en el Bloque 5.1: una respuesta provisional no gasta la clave
de idempotencia.

```bash
npm run evidence:webpay -- --caso "2. Consulta de estado sin pagar"
```

### 3. Crédito aprobado

**Qué**: VISA 4051 8856 0044 6623, CVV 123, RUT 11.111.111-1, clave 123.

Pantalla: «Pago confirmado», el trabajo queda habilitado.

Esperado: `status = PAID`, `provider_status = AUTHORIZED`, `response_code = 0`,
`authorization_code` presente, `payment_type_code` de crédito,
`card_last_digits` con cuatro dígitos, `paid_at` puesto. Un payout creado por
el neto. Asignación habilitada. Notificaciones al cliente y al trabajador.

### 4. Crédito rechazado

**Qué**: MASTERCARD 5186 0595 5959 0568.

Pantalla: «El pago fue rechazado», con la opción de reintentar.

Esperado: `status = FAILED`, `provider_status = FAILED`, `response_code` menor
que cero, **sin payout**, trabajo todavía en `PAYMENT_PENDING`, asignación sin
habilitar.

### 5. Débito aprobado

**Qué**: Redcompra 4051 8842 3993 7763.

Esperado: igual que la 3, con `payment_type_code` de débito (`VD`).

### 6. Débito rechazado

**Qué**: Redcompra 5186 0085 4123 3829.

Esperado: igual que la 4.

### 7. Prepago aprobado

**Qué**: Prepago VISA 4051 8860 0005 6590.

Esperado: igual que la 3, con el tipo de pago de prepago (`VP`).

### 8. Prepago rechazado

**Qué**: Prepago MASTERCARD 5186 1741 1062 9480.

Esperado: igual que la 4.

### 9. Anular desde el formulario

**Qué**: pulsar «Anular compra» en el formulario de Webpay.

Vuelve con `TBK_TOKEN` y sin `token_ws`.

Pantalla: «Cancelaste el pago».

Esperado: `status = FAILED` con `failure_reason = aborted_by_user`. **No se
llama a `commit`**: el flujo abortado no se confirma nunca. Sin payout.

### 10. Tiempo agotado del formulario

**Qué**: abrir el formulario y dejarlo quieto más de 10 minutos.

Vuelve con `TBK_ID_SESION` y `TBK_ORDEN_COMPRA`, sin `token_ws`.

Pantalla: «Se agotó el tiempo».

Esperado: `status = FAILED` con el motivo del tiempo agotado, sin payout. Es la
prueba más lenta: conviene lanzarla al principio y dejarla corriendo mientras se
hacen las demás.

### 11. Retorno normal con `token_ws`

Ya está cubierto por las pruebas 3 y 5, pero conviene mirarlo aparte: en el
informe de una aprobada, el evento del asiento lleva la clave
`commit:<token>` y hay **uno solo**.

### 12. Retorno repetido

**Qué**: sobre una prueba ya aprobada, volver a cargar la URL de retorno (la
del historial del navegador).

Pantalla: el mismo resultado de antes.

Esperado: **ningún evento nuevo**, ningún segundo payout, ninguna segunda
notificación, `refunded_amount` sin tocar. Es la idempotencia, vista desde
fuera.

### 13. Consulta de estado después de pagar

**Qué**: «Consultar al proveedor» sobre una aprobada.

Esperado: Webpay contesta `AUTHORIZED` y **no pasa nada**: mismo estado, sin
evento nuevo, sin segundo payout. La consulta comparte clave con el asiento a
propósito.

### 14. Conciliación

**Qué**: crear una transacción (prueba 1), pagarla en el formulario y **cerrar
la pestaña antes de volver**. Después, en `/admin/pagos`, «Conciliar
pendientes».

Esperado: el pago pasa a `PAID` por la vía de la conciliación —con
`reconciled_at` puesto— y con el mismo evento que habría escrito el retorno. El
resumen de la acción dice cuántos examinó, cuántos cambió y cuántos quedaron
fuera de ventana.

Es la prueba que más importa: es el único camino que queda cuando el navegador
de quien paga no vuelve.

### 15. Devolución total en integración

**Qué**: desde `/admin/pagos`, sobre una aprobada del mismo día, pedir la
devolución del importe completo. Hace falta ser administración y escribir un
motivo de al menos diez caracteres.

Esperado: Transbank responde una **reversa** (`REVERSED`) si es el mismo día y
por el total. El pago queda `REFUNDED`, el payout se congela y queda la fila en
`payment_refunds` con su tipo, más la entrada de auditoría con quién lo pidió.

> Esto es una devolución **de integración**, con dinero que no existe. Una
> devolución productiva necesita una autorización aparte.

### 16. Devolución parcial

**Qué**: sobre otra aprobada, pedir una parte del importe.

Esperado: Transbank responde una **anulación** (`NULLIFIED`) con
`nullified_amount`, `balance` y su propio código de autorización. El pago queda
`PARTIALLY_REFUNDED` y `refunded_amount` cuadra con la suma de las devoluciones
confirmadas.

Si el ambiente de integración no permite la anulación parcial ese día, **no se
finge**: se anota qué respondió y se deja la prueba como no concluyente.

### 17. Pago de una extensión

**Qué**: con un trabajo en marcha, el trabajador pide más tiempo desde el panel
de ejecución, el cliente lo acepta y paga.

Esperado: un pago **nuevo y separado**, con `purpose` de extensión, su propia
`buy_order`, su propio token y sus propios eventos. El pago original no se
toca. Al aprobarse, los minutos se suman a la asignación.

### 18. Cancelación con el pago en vuelo

**Qué**: crear la transacción (prueba 1) y, con el formulario de Webpay abierto
en otra pestaña, cancelar el trabajo desde la aplicación. Después volver al
formulario y pagar.

Esperado: la cancelación gana. El pago **no habilita nada**: queda como
`UNDER_REVIEW` o `FAILED` según el caso, sin payout, con el trabajo cancelado.
Si Webpay llegó a cobrar, aparece en la cola de revisión para devolverlo a
mano; no se habilita trabajo alguno por el camino.

Es la política de cancelación del commit `a30f290`, que no cambió: si hay que
elegir entre cobrar de más y habilitar de más, se elige lo que se puede
deshacer.

> Son dieciocho apartados para diecisiete pruebas porque la número 11 —el
> retorno normal— se comprueba sobre las aprobadas, no con una transacción
> propia.

---

## 6. Al terminar: la batería completa

```bash
npm run check                 # lint, tipos, 76 pruebas unitarias, build
npm run db:test               # 225 comprobaciones contra PostgreSQL local
npm run db:contract           # contraste entre el código y el esquema
npm run db:push:hosted -- --plan
npm run verify:schema:hosted
npm run verify:supabase       # 62
npm run verify:payments       # 23
npm run verify:execution      # 24
npm run verify:pwa            # 30
npm run verify:transbank      # 31 de 31, SIN ALLOW_OFFLINE
npm run e2e                   # 51
```

`verify:transbank` es el que cambia: desde una red permitida tiene que dar
**31 de 31**, sin ninguna OMITIDA y **sin** `ALLOW_OFFLINE=1`. Si sigue
marcando siete omitidas, la red todavía no alcanza a Transbank y el resto de
este documento no se puede dar por hecho.

`db:test` necesita PostgreSQL local:

```bash
PGHOST=/tmp PGPORT=55432 PGUSER=postgres npm run db:test
```

---

## 7. Lo que se le entrega a Transbank

El listado de órdenes, ya con formato de tabla:

```bash
npm run evidence:webpay -- --lista
```

Y por cada caso, de `evidencia/webpay-integration.md`: orden de compra, fecha y
hora, importe, resultado y estado almacenado. Las capturas de pantalla van
aparte: la pantalla de pago, el formulario de Webpay, el resultado y, cuando
aporte, `/admin/pagos`.

El logotipo ya está en `brand/logo-transbank-130x59.png` (130 × 59 px, fondo
blanco). Se regenera con `npm run brand:logo`.

> **El formulario de validación no se envía sin autorización expresa.** Tampoco
> se manda ningún correo a Transbank por iniciativa propia.

---

## 8. Después

Nada de esto activa producción. Cuando la validación esté aprobada —aprobada
por Transbank, no por nosotros— la lista para el primer cobro real está en
`TRANSBANK.md` §9, y el interruptor sigue pidiendo autorización expresa antes de
tocarse.
