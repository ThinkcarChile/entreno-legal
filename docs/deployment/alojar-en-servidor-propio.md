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

`next.config.ts` compila en modo `standalone`. Eso deja en
`web/.next/standalone/` un servidor Node autocontenido —`server.js`,
`package.json` y solo las dependencias que de verdad se usan—.

**Verificado el 2026-09-02 con `npm run pwa:empaquetar`**: el build corre limpio
(`✓ Compiled successfully`), genera **49 rutas** (48 dinámicas y `/_not-found`),
el bundle armado pesa **63,0 MB en 2172 archivos** (56,2 MB son `node_modules`)
y el zip queda en **18,6 MB con 2646 entradas**. Los números salen del resumen
que imprime el script, no de memoria: si al leer esto cambiaron, el script los
vuelve a imprimir.

#### Cómo se arma, exactamente

Un solo comando, desde `web/`:

```bash
cd web
npm run pwa:empaquetar               # compila, arma, valida y deja el zip
npm run pwa:empaquetar -- --limpio   # lo mismo, pero antes borra .next y corre npm ci
npm run pwa:validar                  # revisa un bundle ya armado, sin compilar
```

Desde un checkout limpio (sin `node_modules`): `git clone …`, `cd web`,
`npm run pwa:empaquetar -- --limpio`. Necesita `web/.env.local` con
`NEXT_PUBLIC_SUPABASE_URL` y `NEXT_PUBLIC_SUPABASE_ANON_KEY`: `next build`
hornea esos dos valores en el bundle del cliente, así que el proyecto con el que
se compila tiene que ser el mismo al que apunta el servidor. Si faltan, el
script se niega a compilar.

Lo que hace `scripts/empaquetar-pwa.mjs`, en orden, y FALLA en cualquier paso:

1. `next build`. Si el build falla, se detiene: no sigue con un bundle viejo.
2. Arma `web/.next/standalone/`: copia `.next/static` a
   `standalone/.next/static` y `public/` a `standalone/public`. El standalone
   NO se basta solo: sin esas dos copias la app carga sin estilos, sin íconos y
   sin PWA instalable. Antes eran tres `cp -r` escritos en este documento, o
   sea tres oportunidades de subir un bundle cojo sin que nada avisara.
3. Estampa la versión del service worker EN LA COPIA: reemplaza
   `const VERSION = "v1";` por `<versión de package.json>-<sha corto de git>`
   (por ejemplo `0.1.0-a873a10`). El fuente `web/public/sw.js` sigue diciendo
   `v1`. Con eso cada despliegue estrena nombres de caché y el `activate` del
   worker bota los del despliegue anterior: el icono viejo ya no queda pegado
   en los celulares que tenían la app instalada. Si el árbol tiene cambios sin
   commit, la estampa lleva `-sucio-<fecha-hora>` y el zip `-sucio`: se
   declara, no se esconde.
4. Valida el bundle: `server.js`, `package.json`, `.next/BUILD_ID`,
   `node_modules`, `.next/static` con contenido, y `public/` con el manifiesto
   (JSON válido; `name`, `short_name`, `start_url`, `scope`,
   `display: standalone`, `theme_color`, `background_color`; PNG de 192 y 512
   con purpose `any` y `maskable`; cada icono existiendo de verdad en disco),
   `sw.js` estampado y `sin-conexion.html`. Si falta cualquiera, NO escribe el
   zip.
5. Escribe en `dist/` (raíz del repo, ignorado por git):
   - `nutrifamilia-pwa-<sha>.zip`: el bundle entero, con `server.js` en la
     raíz; se sube y se descomprime tal cual. Lo arma con `tar.exe` (bsdtar,
     viene con Windows 10+) o con `zip` en Linux, y después lo LISTA: tiene
     que traer `server.js` y ninguna ruta con barra invertida
     (`Compress-Archive` de PowerShell 5.1 las escribe así, y en un servidor
     Linux salen archivos sueltos llamados `.next\static\…`).
   - `VARIABLES-DE-ENTORNO.md`: la lista exacta de variables que el servidor
     necesita y cuál JAMÁS va, generada de la misma lista que usa el script.
6. Imprime el resumen: sha, estampa, tamaños (bundle, static, public,
   node_modules) y el zip con su cantidad de entradas.

`web/src/lib/pwa.test.ts` vigila las dos puntas: que el fuente traiga
exactamente lo que el script busca (el marcador de versión, una sola vez; los
campos e iconos del manifiesto) y que el validador del script de verdad falle
cuando falta cada pieza.

#### El tropiezo que cuesta una reconstrucción

**No corras el servidor de desarrollo después de empaquetar.** `npm run dev`
reescribe `.next` entero y se lleva `standalone/` por delante — el directorio
simplemente desaparece, sin ningún aviso. El zip en `dist/` sobrevive (está
fuera de `.next`), pero `npm run pwa:validar` ya no tiene qué revisar y un zip
sin bundle al lado no se puede volver a comprobar. Empaquetar es lo último que
se hace antes de subir; si hubo que volver a desarrollo, se vuelve a empaquetar.

#### Lo que el bundle sí trae, y qué guarda el service worker

`public/` lleva `manifest.webmanifest`, `sw.js` (el service worker, ya
estampado), `sin-conexion.html` (la pantalla sin conexión), `icon.svg`,
`apple-touch-icon.png` y la carpeta `icons/`. O sea: **la PWA completa**, lista
para instalarse desde cualquier origen HTTPS.

El worker guarda SOLO el armazón (`sin-conexion.html`, manifiesto, iconos) y
los estáticos de `/_next/static` (llevan el hash del contenido en el nombre).
No guarda nunca: nada de otro origen (Supabase Storage con sus URL firmadas,
PostgREST, Auth), ningún archivo bajo `/api`, `/health`, `/salud` ni
`/finanzas`, ninguna pantalla, ningún payload RSC, ni ninguna respuesta que el
servidor marque `Cache-Control: no-store` o `private`. Documentos médicos y
boletas jamás tocan el caché. Está escrito en la cabecera de
`web/public/sw.js` y comprobado por mutación en
`web/src/app/sw-no-cachea-datos.test.ts` y `web/src/lib/pwa.test.ts`.

---

## Camino A — cPanel con "Setup Node.js App"

Muchos planes de HostGator y similares traen esa opción (es Passenger sobre
CloudLinux). **Antes de planificar nada, hay que mirar si está**: entra al cPanel
y busca *Setup Node.js App* o *Node.js Selector* en la sección de Software.

**Si está**, el camino es:

1. Crear la aplicación con Node 20 o superior (la app se desarrolla en 24).
2. Subir `dist/nutrifamilia-pwa-<sha>.zip` (lo deja `npm run pwa:empaquetar`)
   y descomprimirlo en la raíz de la aplicación: `server.js` tiene que quedar en
   esa raíz, con `.next/`, `public/` y `node_modules/` al lado. No hay que
   copiar nada más a mano: el zip ya trae `.next/static` y `public/` adentro, y
   el script se negó a escribirlo si faltaba algo.
3. Application startup file: `server.js`.
4. Variables de entorno: las de `dist/VARIABLES-DE-ENTORNO.md`, que el script
   genera junto al zip: `NEXT_PUBLIC_SUPABASE_URL` y
   `NEXT_PUBLIC_SUPABASE_ANON_KEY` (las MISMAS con las que se compiló), `PORT`
   (el que asigne cPanel), `HOSTNAME` (`0.0.0.0` salvo que el hosting exija
   otra) y `NODE_ENV=production`. **`SUPABASE_ACCESS_TOKEN` NO va acá** — ese
   token corre SQL arbitrario sobre toda la cuenta y la app no lo necesita
   nunca. Tampoco `SUPABASE_SERVICE_ROLE_KEY`: salta las políticas RLS.
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

**Que producción tenga la cadena de migraciones completa.** Hoy (2026-09-02) la
tiene: 59 aplicadas, cero pendientes, verificado en vivo con los testigos. Si
cuando leas esto hubo migraciones nuevas, el estado real sale de acá, nunca de
memoria:

```bash
node scripts/verificar-estado-produccion.mjs   # le pregunta a la base qué tiene
node scripts/poner-al-dia.mjs --pendientes     # muestra el plan, no toca nada
node scripts/poner-al-dia.mjs --sellar         # congela el checksum de cada pendiente
node scripts/poner-al-dia.mjs --pendientes --aplicar
```

El sello importa más de lo que parece: a partir de ahí el aplicador se DETIENE si
una migración cambió después de sellarse. Entre "la revisé" y "la apliqué" cabe
una edición que nadie nota.

**Lo que respalda que aplicar va a funcionar:** `web/src/integration/ensayo-despliegue.test.ts`
levanta una base EN EL ESTADO REAL DE PRODUCCIÓN —con datos en cada tabla que las
pendientes alteran, no vacía— aplica las pendientes en orden y compara columna por
columna contra la cadena desde cero. Y aun así, el 2026-09-02 un pre-vuelo
adversarial encontró un defecto que ese ensayo no podía ver (un guardián que moría
en cascada, invisible sin un día con comidas que borrar). Para un despliegue con
migraciones nuevas, vale la pena correr los dos.

**Y después de publicar**, en Supabase → Authentication → URL Configuration: hay
que agregar el dominio nuevo a *Site URL* y *Redirect URLs*. Si no, el login
rebota y parece que la app está rota cuando solo falta esa línea.
