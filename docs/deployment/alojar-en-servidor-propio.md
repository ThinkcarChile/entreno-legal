# Alojar la app en un servidor propio, como PWA

Francisco pidió publicarla como PWA y alojarla en alguno de sus sitios. Las dos
cosas se pueden, pero son independientes y conviene separarlas antes de tocar
nada, porque la confusión entre ambas es la que hace perder una tarde.

---

## Lo primero: PWA y hosting no son la misma decisión

**La PWA ya está construida.** Hay manifiesto, service worker, íconos y pantalla
sin conexión. Una PWA se instala desde cualquier origen **HTTPS**, sea el que
sea: no depende de dónde esté alojada. Si mañana la app vive en
`comida.tudominio.cl`, se instala desde ahí y aparece en el teléfono con su
ícono, sin pasar por ninguna tienda.

**El hosting es otra cosa**, y ahí sí hay una restricción dura.

---

## Esta app NECESITA un Node corriendo. No es opcional.

No es una preferencia de arquitectura: está medido sobre el código de hoy.

| lo que hay | cuánto |
|---|---|
| archivos con `"use server"` (server actions) | **19** |
| páginas que leen la sesión en el servidor | **54** |
| páginas realmente estáticas | prácticamente ninguna |

El login, el plan de la semana, la despensa, la lista de compra y todo el módulo
de salud leen la sesión del lado del servidor y escriben por server actions. Una
exportación estática (`output: 'export'`) no es "la misma app más simple": es una
app que no puede iniciar sesión ni guardar nada.

**Conclusión:** el hosting tiene que poder correr Node. Un hosting que solo sirve
archivos (el HTML/PHP clásico de cPanel) no alcanza.

### Lo que sí está listo

`next.config.ts` ahora compila en modo `standalone`. Eso deja en
`web/.next/standalone/` un servidor Node autocontenido —`server.js`,
`package.json` y solo las dependencias que de verdad se usan— de unos **65 MB**.
Verificado: el build corre limpio y produce ese bundle.

Eso es exactamente lo que se sube a un servidor propio.

---

## Camino A — cPanel con "Setup Node.js App"

Muchos planes de HostGator y similares traen esa opción (es Passenger sobre
CloudLinux). **Antes de planificar nada, hay que mirar si está**: entra al cPanel
y busca *Setup Node.js App* o *Node.js Selector* en la sección de Software.

**Si está**, el camino es:

1. Crear la aplicación con Node 20 o superior (la app se desarrolla en 24).
2. Subir el contenido de `web/.next/standalone/`, más `web/.next/static/` dentro
   de `.next/static/` y `web/public/` tal cual. Esos dos NO van dentro del
   standalone y sin ellos la app carga sin estilos ni íconos.
3. Application startup file: `server.js`.
4. Variables de entorno: `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `PORT` (el que asigne cPanel) y
   `NODE_ENV=production`. **`SUPABASE_ACCESS_TOKEN` NO va acá** — ese token corre
   SQL arbitrario sobre toda la cuenta y la app no lo necesita nunca.
5. HTTPS con el certificado del dominio (AutoSSL sirve). Sin HTTPS no hay PWA
   instalable: el service worker no se registra.

**Si no está**, no hay que forzarlo: un hosting compartido sin Node no va a
correr esto, y hacerlo funcionar a la mala termina en una app caída un domingo.

### Lo que hay que saber de este camino

- **El deploy es manual.** Cada versión hay que compilarla y subirla. Es
  perfectamente viable para una app familiar que cambia poco, pero no hay
  "empujar y listo".
- **Passenger reinicia el proceso cuando quiere.** La app no guarda estado en
  memoria (todo vive en Supabase), así que no molesta.
- **Memoria.** Un Next en producción parte en ~150-250 MB. Si el plan tiene un
  tope bajo de RAM por proceso, se va a caer bajo carga.

---

## Camino B — un host de Node, con TU dominio adelante

Un host pensado para Node (Vercel, Render, Fly, Railway) corre esto sin
configuración, y **igual queda en tu dominio**: se apunta un subdominio —
`comida.tudominio.cl`, `mesa.tudominio.cl`— con un CNAME, y la app se ve y se
instala desde ahí. Nadie ve una URL ajena.

La diferencia real con el camino A no es el dominio: es que acá el deploy es
automático en cada push y el certificado se renueva solo.

**Los dos caminos dan exactamente la misma PWA en el mismo dominio.** Lo que
cambia es quién mantiene el servidor.

---

## Qué hay que revisar antes de decidir

Tres preguntas concretas al cPanel, y con eso se decide:

1. ¿Existe *Setup Node.js App*? ¿Qué versiones de Node ofrece?
2. ¿Cuánta RAM por proceso permite el plan?
3. ¿El dominio o subdominio que vas a usar tiene AutoSSL activo?

Con las tres respuestas, el camino se elige solo.

---

## Y esto va antes que cualquiera de los dos

**Aplicar las migraciones 0036 y 0038.** El código ya consulta objetos que
producción no tiene: si la app se publica antes, `/pantry`, `/pantry/reorder`,
`/pantry/item/[id]` y `/procurement` fallan el primer día. No es un detalle de
despliegue — es la diferencia entre publicar una app y publicar una app rota.

```bash
node scripts/poner-al-dia.mjs --aplicar 0036 0038
```

**Y después de publicar**, en Supabase → Authentication → URL Configuration: hay
que agregar el dominio nuevo a *Site URL* y *Redirect URLs*. Si no, el login
rebota y parece que la app está rota cuando solo falta esa línea.
