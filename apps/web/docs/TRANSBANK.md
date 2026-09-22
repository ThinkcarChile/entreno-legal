# Webpay Plus: integración, operación y puesta en producción

Todo lo que hace falta para operar los pagos: cómo funciona la integración, qué
variables van en el hosting, cómo conciliar, cómo devolver, qué hacer cuando
algo se rompe, y el camino exacto —con su lista de comprobación— para el
primer cobro real.

> **Producción está desactivada.** Hace falta un acto explícito y auditable
> para activarla, descrito en §9. Mientras tanto, el único ambiente que opera
> es el de integración, donde el dinero no es real.

---

## 1. Qué hay conectado

| Pieza | Valor |
|---|---|
| Producto | Webpay Plus (venta normal, no diferida, no mall) |
| SDK | `transbank-sdk` **6.1.1**, versión exacta en `package.json` y en el lockfile |
| Origen | [TransbankDevelopers/transbank-sdk-nodejs](https://github.com/TransbankDevelopers/transbank-sdk-nodejs) |
| Node mínimo | 18 (el proyecto corre en 22) |
| Ambiente activo | `integration` |
| API | REST v1.2 (`/rswebpaytransaction/api/webpay/v1.2`) |

Las cuatro operaciones que se usan, todas del SDK oficial:

```
create(buyOrder, sessionId, amount, returnUrl)  → { token, url }
commit(token)                                   → resultado de la autorización
status(token)                                   → estado, hasta 7 días
refund(token, amount)                           → reversa o anulación
```

No se usan llamadas REST a mano, ni SOAP, ni paquetes de terceros. La captura
diferida y el mall no se contrataron y no se implementan.

### Dónde vive

`src/lib/payments/transbank/` y **en ningún otro sitio**. Ninguna página,
componente, acción de servidor o repositorio importa el SDK. El resto de la
aplicación habla el contrato de `PaymentProvider`, que ya existía desde la
Etapa 1 y no cambió.

| Archivo | Qué hace |
|---|---|
| `sdk.ts` | Acceso portable al SDK (ver la nota de abajo) |
| `config.ts` | Ambientes, credenciales de integración y guardas de producción |
| `identifiers.ts` | `buy_order` y `session_id` |
| `mapping.ts` | De la respuesta de Webpay al dominio |
| `return-flow.ts` | Clasificación de los cuatro retornos |
| `sanitize.ts` | Saneado de secretos y de cargas útiles |
| `provider.ts` | `TransbankPaymentProvider` |

**Nota sobre el import.** El paquete no declara `exports`: publica `main` en
CommonJS y `module` en ESM. Un `import { WebpayPlus } from "transbank-sdk"`
funciona dentro de Next —que resuelve `module`— y **falla en Node puro**, que
resuelve `main`. Como el verificador corre en Node suelto, `sdk.ts` resuelve
las dos formas: lo que se verifica tiene que ser lo que se ejecuta.

---

## 2. El recorrido, paso a paso

```
cliente pulsa «Pagar»
  → start_protected_payment (base: calcula el importe, bloquea, reutiliza o crea)
  → buildBuyOrder + buildSessionId
  → register_payment_attempt  ← SE PERSISTE ANTES DE SALIR
  → Transaction.create(...)
  → se guardan token y URL
  → /pagar/{id}/ir            ← página de transición
  → formulario POST con token_ws hacia Webpay
  ...
  → /pagos/retorno            ← GET o POST, cuatro flujos
  → Transaction.commit(token) (solo en el flujo normal)
  → confirm_payment_result    ← ÚNICA vía de asentamiento
```

### Por qué el intento se persiste antes de llamar

Porque el caso peor es real: Transbank crea la transacción y la respuesta se
pierde por la red. Sin el intento escrito, esa transacción existiría en su lado
y no en el nuestro, y nadie podría encontrarla. Con `buy_order` y `session_id`
ya en la base, la conciliación la localiza.

### Lo que nunca viene del navegador

El total, la comisión, el bono, el importe de una extensión, la orden de
compra, el token y la URL de retorno. Todo se calcula o se construye en el
servidor. Lo único que llega de fuera es el identificador de la asignación, y
sobre él se comprueba la propiedad.

---

## 3. Identificadores

### `buy_order` — máximo 26 caracteres

```
HTF-9F8E7D6C5B4A-2VF8C68BN
│   │            └─ 9 caracteres aleatorios (alfabeto de 28, sin vocales)
│   └─ 12 dígitos hexadecimales del UUID del pago
└─ prefijo fijo
```

Tres propiedades a la vez: **trazable** (de la orden se saca el pago sin
consultarlo), **única aunque se reintente** (Webpay rechaza reutilizar la de
una transacción viva) y **sin depender del reloj**.

El sufijo empezó en 6 caracteres. `verify:transbank` encontró una colisión en
10.000 a la primera —con 28⁶ ≈ 4,8·10⁸ el cumpleaños muerde antes de lo que
parece— y con índice único eso es un pago que no se puede iniciar. Con 9 son
≈10¹³ combinaciones.

### `session_id` — máximo 61 caracteres

`S-` + el UUID del pago sin guiones. Sin correo, sin RUT, sin teléfono, sin
nombre, y **no es la sesión de Supabase**. Vuelve como `TBK_ID_SESION` cuando
el retorno no trae token, y es lo que permite reencontrar el intento. No
autoriza nada: quien vuelve sigue teniendo que ser el dueño del pago.

---

## 4. Los cuatro retornos

La ruta `/pagos/retorno` acepta **GET y POST**. El retorno normal es GET desde
la versión 1.1 del API; el pago abortado en integración sigue llegando por
POST. Atender solo uno deja un flujo entero sin recoger.

| Flujo | Llega | Qué se hace | Estado final |
|---|---|---|---|
| **Normal** | `token_ws` | `commit` | `PAID` o `FAILED` |
| **Tiempo agotado** | `TBK_ID_SESION`, `TBK_ORDEN_COMPRA` | nada que confirmar | `FAILED` (`form_timeout`) |
| **Abortado** | `TBK_TOKEN`, `TBK_ID_SESION`, `TBK_ORDEN_COMPRA` | `status`, nunca `commit` | `FAILED` (`aborted_by_user`) o el estado real |
| **Error / volver al sitio** | los cuatro | `status`, nunca `commit` | `FAILED` (`return_conflict`) o el estado real |

El cuarto es donde se pierde dinero o se cobra de más: llega un `token_ws` que
invita a confirmar junto a un `TBK_TOKEN` que dice que la transacción no
terminó bien. **No se elige uno por gusto**: no se confirma, se consulta el
estado, que es la única fuente que no depende de lo que traiga la URL.

Los tres flujos sin cobro pueden esconder una autorización real. Si hay token,
se pregunta antes de darlos por perdidos; y si el proveedor dice que sí está
autorizada, se asienta por la misma vía que el retorno normal.

Plazos: el formulario dura **4 minutos en producción y 10 en integración**; el
token creado caduca a los **5 minutos** si nadie lo usa.

---

## 5. Criterio de aprobación

Una transacción está aprobada cuando, **a la vez**:

- `status` es exactamente `AUTHORIZED`
- `response_code` es exactamente `0`

Y además, antes de asentar, se comprueba que sea **la transacción que se
pidió**: importe, `buy_order` y `session_id` iguales a los del intento, y con
código de autorización presente. Un `AUTHORIZED` sobre otra compra sigue siendo
dinero que no corresponde a este trabajo.

Si está autorizada pero algo no cuadra → `UNDER_REVIEW` con el motivo concreto
(`amount_mismatch`, `buy_order_mismatch`, `session_id_mismatch`,
`missing_authorization_code`), **sin habilitar el trabajo y sin crear pago al
trabajador**.

`vci` se guarda para auditoría y **no decide nunca**: es el resultado de la
autenticación 3-D Secure, no la autorización financiera.

---

## 6. Idempotencia

| Operación | Clave | Cómo se construye |
|---|---|---|
| `create` | `payments.buy_order` | índice único; un intento nuevo estrena orden |
| `commit` | `commit:<token>` | `payment_events (provider, provider_event_id)` |
| `status` | `commit:<token>` | la misma que el commit, a propósito |
| conciliación | `commit:<token>` | la misma; por eso conciliar no duplica |
| `refund` | `refund:<sha256(pago:importe:discriminante)>` | índice único en `payment_refunds` |

Ninguna clave lleva datos secretos: el token no entra en la de devolución
porque una clave de idempotencia acaba en registros y en índices.

**Que el `commit` y la conciliación compartan clave es el punto.** Un pago
asentado por el retorno y luego conciliado no produce un segundo evento, ni un
segundo pago al trabajador, ni una segunda notificación.

Comprobado con retornos secuenciales (W07) y **simultáneos** (X20, cinco
repeticiones).

---

## 7. Conciliación

**Webpay Plus no tiene webhooks.** No se inventa uno. La única fuente de verdad
es el retorno, el `commit` y la consulta de estado.

Si el navegador de quien paga muere entre el formulario y el retorno —batería,
cambio de red, pestaña cerrada— nadie va a contarlo. Hay que preguntarlo.

`reconcilePayments()` toma los pagos sin estado final (`PENDING`, `CREATED`,
`AUTHORIZED`, `UNDER_REVIEW`) con token y de menos de 7 días, pregunta a
Transbank y los asienta por la misma vía que el retorno.

- Un pago de **integración nunca se pregunta contra producción**, ni al revés.
- Que el proveedor no conteste **no cambia nada**: el pago sigue en la cola.
  Jamás se da por fallido por no poder preguntar.
- La ventana es de 7 días porque es lo que Webpay responde. Pasado ese plazo,
  hace falta una persona.

### Cómo ejecutarla

Hoy, desde `/admin/pagos`: «Conciliar pendientes» para la cola, o «Consultar al
proveedor» sobre un pago concreto cuando alguien escribe preguntando.

**No hay programador de tareas en el hosting y no se finge uno.** Cuando lo
haya, la frecuencia recomendada es:

| Cuándo | Cada |
|---|---|
| Horario de uso | 10 minutos |
| Resto del día | 1 hora |
| Barrido de rezagados | 1 vez al día, con `olderThanMinutes: 1440` |

El servicio es idempotente, así que ejecutarlo de más no hace daño.

---

## 8. Pruebas en integración

### Credenciales

Las publica Transbank y las trae el SDK. **No se configuran ni se guardan**:
así nadie las confunde con las de verdad.

| | |
|---|---|
| Código de comercio | `597055555532` (Webpay Plus) |
| Llave secreta | la que expone `IntegrationApiKeys.WEBPAY` |
| Host | `webpay3gint.transbank.cl` |

### Tarjetas de prueba

| Tarjeta | Número | CVV | Resultado |
|---|---|---|---|
| VISA | 4051 8856 0044 6623 | 123 | **aprobada** |
| AMEX | 3700 0000 0002 032 | 1234 | **aprobada** |
| MASTERCARD | 5186 0595 5959 0568 | 123 | **rechazada** |
| Redcompra (débito) | 4051 8842 3993 7763 | — | **aprobada** |
| Redcompra (débito) | 4511 3466 6003 7060 | — | **aprobada** |
| Redcompra (débito) | 5186 0085 4123 3829 | — | **rechazada** |
| Prepago VISA | 4051 8860 0005 6590 | 123 | **aprobada** |
| Prepago MASTERCARD | 5186 1741 1062 9480 | 123 | **rechazada** |

Fecha de expiración: cualquiera futura. Autenticación bancaria: RUT
**11.111.111-1**, clave **123**.

> **Nunca una tarjeta real en integración.**

### Recorrido a mano

Desde una red que alcance a Transbank (ver §12):

1. `PAYMENT_PROVIDER=transbank` y `TRANSBANK_ENVIRONMENT=integration`.
2. `npm run dev`, entrar como cliente, aceptar una oferta, ir a pagar.
3. Comprobar que la pantalla dice «Ambiente de integración».
4. Pulsar «Pagar con Webpay» → página de transición → formulario de Webpay.
5. **Aprobada**: VISA 4051 8856 0044 6623, CVV 123, RUT 11.111.111-1, clave
   123. Al volver: trabajo habilitado, pago `PAID`, payout creado.
6. **Rechazada**: MASTERCARD 5186 0595 5959 0568. Al volver: «El pago fue
   rechazado», sin cobro, se puede reintentar.
7. **Abortada**: pulsar «Anular compra» en el formulario. Al volver:
   «Cancelaste el pago», `FAILED` con `aborted_by_user`.
8. **Tiempo agotado**: dejar el formulario 10 minutos sin tocar.
9. **Retorno repetido**: recargar la página de retorno. No se cobra dos veces.
10. En `/admin/pagos`, «Consultar al proveedor» sobre cada uno.

---

## 9. Producción

### Variables del hosting

| Variable | Valor | Notas |
|---|---|---|
| `PAYMENT_PROVIDER` | `transbank` | |
| `TRANSBANK_ENVIRONMENT` | `production` | |
| `TRANSBANK_PRODUCTION_ENABLED` | `true` | **el interruptor** |
| `TRANSBANK_PRODUCTION_COMMERCE_CODE` | el del comercio | solo servidor |
| `TRANSBANK_PRODUCTION_API_KEY_SECRET` | la llave | solo servidor |
| `NEXT_PUBLIC_SITE_URL` | `https://hagotufila.cl` | HTTPS, sin puerto |
| `NODE_ENV` | `production` | |

Las credenciales productivas **nunca** llevan prefijo `NEXT_PUBLIC_`, nunca se
serializan, nunca se imprimen, nunca aparecen en una página de error, en un
registro, en una prueba ni en Git.

### Las guardas

El proveedor productivo **se niega a construirse** si falta cualquiera de
estas, y dice todos los motivos a la vez:

- `TRANSBANK_ENVIRONMENT` no es exactamente `production`
- falta `TRANSBANK_PRODUCTION_ENABLED=true`
- `NODE_ENV` no es `production`
- falta el código de comercio o la llave
- las credenciales parecen las de integración (llave conocida, o comercio que
  empieza por `5970555555`)
- la URL no es HTTPS, es localhost, lleva puerto o no tiene dominio público
- la aplicación está en modo demostración
- `PAYMENT_PROVIDER` no es `transbank`

**Tener las credenciales no basta.** Hace falta la bandera, que es un acto
explícito y auditable.

### Lista para el primer cobro real

Antes:

- [ ] Transbank aprobó la validación (§10)
- [ ] Dominio productivo con HTTPS y certificado válido
- [ ] URL de retorno accesible desde fuera
- [ ] Registros llegando a algún sitio que se pueda consultar
- [ ] Conciliación programada, o alguien que la ejecute a mano
- [ ] Una persona de guardia durante la ventana
- [ ] Acceso al portal de Transbank para contrastar

El cobro:

- [ ] **Importe bajo** (el mínimo que permita un trabajo real)
- [ ] **Cliente controlado**: una cuenta del equipo, no una persona ajena
- [ ] **Trabajo de prueba**, con el trabajador avisado
- [ ] Monitoreo en tiempo real de los registros

Después, comprobar **todo** esto antes del segundo:

- [ ] La transacción aparece en el portal de Transbank con el mismo
      `buy_order` y el mismo importe
- [ ] `payments`: `PAID`, con autorización, últimos cuatro dígitos y fecha
      contable
- [ ] Un solo `payment_event` con `commit:<token>`
- [ ] Un solo payout, con el neto correcto
- [ ] El trabajador recibió la notificación
- [ ] `app_private.payment_invariant_violations()` devuelve cero filas
- [ ] La conciliación sobre ese pago no cambia nada

### Rollback

Por orden de rapidez:

1. `TRANSBANK_PRODUCTION_ENABLED=false` y redesplegar. El proveedor deja de
   operar; los pagos en vuelo se cierran con la conciliación.
2. Si hace falta parar todo: `PAYMENT_PROVIDER` a un valor que no sea
   `transbank` en un entorno que no sea producción, o retirar el despliegue.
3. Los cobros ya hechos **no se deshacen solos**: se devuelven uno a uno desde
   `/admin/pagos`, con motivo.

---

## 10. Validación de Transbank

Lo que hay que reunir y entregar. **No se envía nada sin autorización.**

| Requisito | Estado |
|---|---|
| Logo PNG o GIF de **130 × 59 px** | ⛔ pendiente: hay que exportarlo de la identidad de `docs/DISENO.md` |
| Órdenes de compra de prueba | se toman de `payments.buy_order` tras el recorrido de §8 |
| Fecha y hora de cada una | `payments.created_at` y `transaction_date` |
| Flujo aprobado | §8 paso 5 |
| Flujo rechazado | §8 paso 6 |
| Flujo abortado | §8 paso 7 |
| Capturas | de la pantalla de pago, la transición, el formulario y el resultado |
| Dominio de integración | el que se use al hacer el recorrido |
| URL de retorno | `https://<dominio>/pagos/retorno` |
| Descripción de la integración | Webpay Plus, venta normal, moneda CLP, sin captura diferida ni mall |
| SDK y versión | `transbank-sdk` 6.1.1 para Node |

Para sacar los datos de las órdenes de prueba:

```sql
select buy_order, amount, status, provider_status, response_code,
       authorization_code, created_at, transaction_date
  from payments
 where environment = 'integration'
   and buy_order is not null
 order by created_at desc
 limit 20;
```

---

## 11. Runbook de incidentes

### «Pagué y no aparece»

1. `/admin/pagos`, buscar por la orden de compra o el trabajo.
2. «Consultar al proveedor».
3. Si dice autorizada y cuadra → se asienta solo, el trabajo se habilita.
4. Si dice autorizada y **no** cuadra → queda `UNDER_REVIEW` con el motivo. No
   se habilita nada. Contrastar en el portal de Transbank.
5. Si dice no autorizada → no hubo cobro. Que reintente.

### «Me cobraron dos veces»

Casi siempre son dos intentos y solo uno cobrado. En `/admin/pagos`, filtrar
por el trabajo: debe haber **un solo** pago vivo. Si de verdad hay dos
`PAID`, devolver uno (§ devoluciones) y abrir el caso.

### Un pago lleva horas en `CREATED`

Es lo normal si alguien abandonó el formulario. La conciliación lo cierra. Si
tiene más de 7 días, Webpay ya no responde: hace falta el portal.

### El proveedor no responde

Los pagos nuevos fallan al crearse y quedan con `failure_reason = provider_error`.
Los que estén en vuelo se quedan en la cola. **No se toca nada**: cuando vuelva,
la conciliación cierra. Comprobar el estado de Transbank antes de mover nada.

### Devolver

Solo administración, desde `/admin/pagos`:

1. Comprobar el saldo devolvible.
2. Escribir el motivo (queda en la auditoría con quién lo pidió).
3. Confirmar.

Por el total dentro del mismo día es una **reversa**; por menos o más tarde,
una **anulación**. Lo devuelto es lo que diga el banco, no lo que se pidió. Si
el banco no confirma, no se devolvió nada y queda registrado como fallida.

Una devolución **total** retiene automáticamente el pago al trabajador. Retener
y no cancelar: puede que el trabajador sí hiciera el trabajo, y esa decisión es
de una persona.

---

## 12. Lo que NO se pudo probar aquí, y por qué

El cortafuegos de Transbank (Imperva) responde **HTTP 403 a las peticiones
desde direcciones de centros de datos**, incluida la de este entorno de
desarrollo. Se comprobó con el SDK, con `curl`, con distintos agentes de
usuario y contra la raíz del dominio: siempre 403, con un `incident_id` de
Imperva.

No es un fallo de la integración, ni de las credenciales, ni del código.

En consecuencia, **no se ejecutó ninguna transacción real en el ambiente de
integración desde este entorno**, y `npm run verify:transbank` marca esas
comprobaciones como OMITIDAS —no como aprobadas— y termina con código distinto
de cero.

Lo que queda pendiente de ejecutar desde una red que alcance a Transbank:

- crear una transacción real y comprobar el token y la URL
- consultar su estado
- pagar con cada tarjeta de prueba (aprobada, rechazada, débito, prepago)
- abortar desde el formulario
- agotar el tiempo del formulario
- una devolución real de integración (reversa y anulación parcial)
- el recorrido de §8 completo

Todo lo demás —los cuatro flujos de retorno, la idempotencia, la conciliación,
las devoluciones, las guardas y los invariantes— **sí está probado**, contra la
base real y con el proveedor simulado, que implementa la misma interfaz.
