/**
 * El motor de la restauración, separado de la línea de comandos.
 *
 * Por qué existe este archivo. Durante una ronda entera el único camino que de
 * verdad rescata a la familia —`--destino supabase`, el que borra e inserta en
 * la base viva— NUNCA ejecutó una sola escritura en ninguna parte. Lo que se
 * probaba era el ensayo contra PGlite, que es OTRO camino: no reenlaza cuentas,
 * no filtra las llaves foráneas de `auth`, y restaura `auth.users` en vez de
 * dejarla en manos de Supabase Auth. Un respaldo cuya restauración real nadie
 * probó no es un respaldo: es un archivo.
 *
 * Acá el motor recibe el ejecutor y el modo POR SEPARADO. Eso permite correr el
 * camino de la base viva —el mismo código, con sus reenlaces y sus filtros—
 * contra un Postgres desechable, escribiendo de verdad, en una prueba
 * automatizada. Lo hace `web/src/integration/respaldo-camino-real.test.ts`.
 *
 * Lo que sigue sin poder probarse así está declarado en `comprobarPermisoDeReplicacion`.
 */

import {
  SALTO,
  TABLAS_CLINICAS,
  SQL_ESQUEMA,
  SQL_SONDA_REPLICACION,
  SQL_RESET_REPLICACION,
  PREAMBULO_CARGA,
  columnasGuardadas,
  exigirArreglo,
  expresionEscritura,
  expresionFila,
  hashDeFilas,
  ident,
  interpretarSonda,
  literal,
  ordenDe,
} from "./respaldo-lib.mjs";

/**
 * Se lanza cuando la restauración NO puede seguir. Es una clase aparte para que
 * la línea de comandos la traduzca a código de salida y una prueba la pueda
 * atrapar y leer el mensaje, sin que nadie tenga que llamar a `process.exit`
 * desde adentro del motor.
 */
export class AbortoDeRestauracion extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.name = "AbortoDeRestauracion";
  }
}

/**
 * Envuelve un ejecutor para que las ESCRITURAS se anoten en vez de correrse.
 *
 * Las lecturas pasan tal cual al destino real: el modo en seco tiene que ver el
 * esquema, los conteos y las cuentas de verdad, porque justamente eso es lo que
 * decide qué sentencias se generan. Lo único que no ocurre es el borrado y el
 * insert.
 */
export function ejecutorEnSeco(real) {
  const sentencias = [];
  return {
    nombre: `${real.nombre} (EN SECO: no escribe)`,
    sentencias,
    ejecutar: (sql) => real.ejecutar(sql),
    async escribir(sql) {
      sentencias.push(sql);
      return [];
    },
  };
}

// ---------------------------------------------------------------------------
// El generador de sentencias (puro: sin base de datos adentro)
// ---------------------------------------------------------------------------

/**
 * La sentencia que carga UNA tabla: borra lo que haya y mete las filas.
 *
 * Un solo INSERT por tabla: los disparadores de integridad son AFTER ROW y se
 * disparan al terminar la sentencia, así que una fila que se apunta a sí misma
 * (`granted_by`, `created_by`) entra sin problema.
 */
export function sqlCargarTabla(definicion, filas) {
  const esquema = definicion.esquema ?? "public";
  const cols = columnasGuardadas(definicion);
  const destino = `${ident(esquema)}.${ident(definicion.nombre)}`;
  const borrado = `delete from ${destino};`;
  if (filas.length === 0) return borrado;

  const json = JSON.stringify(filas);
  const lista = cols.map((c) => ident(c.nombre)).join(", ");
  const valores = cols.map((c) => expresionEscritura(c)).join(", ");
  return (
    `${borrado} insert into ${destino} (${lista}) select ${valores} ` +
    `from jsonb_array_elements(${literal(json)}::jsonb) as r;`
  );
}

/**
 * Todo el plan de carga, tabla por tabla, ANTES de tocar el destino.
 *
 * Se arma entero primero a propósito. El reenlace de cuentas puede descubrir un
 * `user_id` que no está en ninguna parte, y descubrirlo a mitad de la carga
 * significa descubrirlo con la base real ya borrada. Acá eso revienta con la
 * base todavía intacta.
 */
export function planDeCarga({ orden, esquemaRespaldo, porNombre, columnasDeUsuario, mapaUsuarios }) {
  const desconocidos = [];
  const plan = orden.map((nombre) => {
    const definicion = esquemaRespaldo.get(nombre);
    const bloque = porNombre.get(nombre);
    if (!definicion || !bloque) {
      throw new AbortoDeRestauracion(
        `El respaldo declara ${nombre} en la cabecera pero no trae sus filas. Archivo inconsistente.`,
      );
    }
    const columnas = columnasDeUsuario.filter((c) => c.tabla === nombre).map((c) => c.columna);
    const filas =
      columnas.length === 0 || mapaUsuarios === null
        ? bloque.datos
        : bloque.datos.map((fila) => {
            const copia = { ...fila };
            for (const col of columnas) {
              const viejo = copia[col];
              if (viejo === null || viejo === undefined) continue;
              const nuevo = mapaUsuarios.get(viejo);
              if (nuevo === undefined) {
                // Antes acá había un `mapaUsuarios.get(viejo) ?? viejo`, que es
                // exactamente el remapeo silencioso que el comentario de al lado
                // decía estar evitando: un id que no está en el bloque auth.users
                // del respaldo (posible con --por-tabla, que no es foto coherente)
                // se insertaba tal cual y sólo se notaba después, en el conteo de
                // huérfanos, con la base real ya borrada y reescrita.
                desconocidos.push(`${nombre}.${col} = ${viejo}`);
                continue;
              }
              copia[col] = nuevo;
            }
            return copia;
          });
    return { tabla: nombre, definicion, filas, sql: `${PREAMBULO_CARGA} ${sqlCargarTabla(definicion, filas)}` };
  });

  if (desconocidos.length > 0) {
    throw new AbortoDeRestauracion(
      [
        "Hay columnas que apuntan a una cuenta que el respaldo NO conoce:",
        ...desconocidos.slice(0, 10).map((d) => `  - ${d}`),
        desconocidos.length > 10 ? `  … y ${desconocidos.length - 10} más` : "",
        "",
        "Esos ids no están en el bloque `auth.users` del archivo, así que no hay forma de",
        "saber a qué persona corresponden en el proyecto destino. Meterlos tal cual dejaría",
        "una ficha médica colgando de otra cuenta, o de nadie.",
        "",
        "Pasa cuando el respaldo se sacó con --por-tabla, que por diseño NO es una foto",
        "coherente entre tablas. Saca uno nuevo sin esa bandera.",
      ]
        .filter(Boolean)
        .join(SALTO),
    );
  }
  return plan;
}

// ---------------------------------------------------------------------------
// La sonda que el ensayo en PGlite no puede correr por construcción
// ---------------------------------------------------------------------------

/**
 * Pregunta al destino si puede apagar las llaves foráneas para cargar.
 *
 * `set session_replication_role = replica` es un parámetro de contexto
 * SUPERUSUARIO. PGlite corre como superusuario, así que el ensayo da verde ahí
 * SIEMPRE y no puede detectar el problema; la Management API de Supabase corre
 * como `postgres`, que no es superusuario. Si el permiso no está, la carga
 * abortaba en la PRIMERA tabla — o sea, el día del desastre, con la base ya
 * borrada.
 *
 * La sonda no escribe una sola fila, así que es segura de correr contra
 * producción. Corre ANTES del primer `delete`.
 *
 * Y DEVUELVE LA SESIÓN A `origin`, siempre, en un `finally`. Durante una ronda
 * entera el comentario afirmaba que lo hacía y nadie lo hacía: la sonda subía
 * `session_replication_role` a `replica` y ahí lo dejaba. El único reset del
 * motor viaja por `escribir` y va DESPUÉS de cargar, así que en `--en-seco` —el
 * modo que se corre contra producción prometiendo no escribirle una fila— el
 * envoltorio en seco lo interceptaba y jamás se enviaba: la sesión quedaba con
 * todos los disparadores apagados, incluidos los de seguridad de las 0033, 0035
 * y 0037. Si la Management API reusa o no esa conexión es justamente lo que
 * nadie midió: es UNKNOWN, y un UNKNOWN no se deja apoyado en un comentario.
 *
 * El reset va por `ejecutar` a propósito (ver `SQL_RESET_REPLICACION`), y si
 * falla se DECLARA en `restablecido`/`motivoRestablecer` en vez de suponerse.
 */
export async function comprobarPermisoDeReplicacion(ejecutor) {
  let veredicto;
  try {
    veredicto = interpretarSonda(await ejecutor.ejecutar(SQL_SONDA_REPLICACION));
  } catch (e) {
    veredicto = {
      permitido: false,
      motivo: `el destino rechazó el SET: ${e instanceof Error ? e.message : String(e)}`,
      detalle: null,
    };
  } finally {
    try {
      await ejecutor.ejecutar(SQL_RESET_REPLICACION);
      veredicto = { ...veredicto, restablecido: true, motivoRestablecer: null };
    } catch (e) {
      veredicto = {
        ...veredicto,
        restablecido: false,
        motivoRestablecer: e instanceof Error ? e.message : String(e),
      };
    }
  }
  return veredicto;
}

const AYUDA_SIN_PERMISO = [
  "NO SE PUEDE APAGAR LA INTEGRIDAD REFERENCIAL EN ESTE DESTINO.",
  "",
  "La carga necesita `set session_replication_role = replica` porque el esquema tiene",
  "un ciclo real (meal_templates ↔ meal_template_versions): no existe orden de",
  "inserción que funcione con las llaves foráneas vivas.",
  "",
  "Ese parámetro es de superusuario. El rol que expone la Management API no lo es",
  "siempre, y el ensayo en PGlite NO puede avisarte: ahí corre como superusuario y",
  "da verde por construcción. Por eso se pregunta acá, ANTES de borrar nada.",
  "",
  "Salidas, en orden de preferencia:",
  "  1. Restaura con `psql` conectado como el dueño de la base (la cadena directa del",
  "     panel de Supabase, no la Management API), que sí puede hacer el SET.",
  "  2. O pide a Supabase el permiso para el rol `postgres` del proyecto.",
  "",
  "Lo que NO se va a hacer solo: cargar con las llaves foráneas vivas «a ver si pasa».",
  "Eso deja la base a medio restaurar y sin forma de saber qué entró.",
].join(SALTO);

// ---------------------------------------------------------------------------
// El motor
// ---------------------------------------------------------------------------

/**
 * Restaura un respaldo en un destino y comprueba que quedó bien.
 *
 * @param modo  "ensayo" = destino desechable (restaura también `auth.users`);
 *              "real"   = base viva (las cuentas las crea Supabase Auth y acá
 *              se reenlazan por correo).
 * @param seco  true = no escribe; sólo genera las sentencias y las devuelve.
 * @param alDetectarDatos  se llama con las tablas que el destino YA tiene con
 *              filas, ANTES de borrar nada. Puede lanzar para abortar. Vive acá
 *              y no en la línea de comandos porque el punto exacto en que se
 *              puede preguntar «¿seguro?» es éste: después ya no hay vuelta.
 */
export async function restaurar({
  respaldo,
  ejecutor,
  modo,
  base = null,
  seco = false,
  aplicarPendientes = true,
  alDetectarDatos = null,
  log = console.log,
}) {
  if (modo !== "ensayo" && modo !== "real") {
    throw new Error(`modo desconocido: ${modo}`);
  }

  const { cabecera, cierre, tablas } = respaldo;
  const porNombre = new Map(tablas.map((t) => [t.nombre, t]));
  const problemas = [];
  const avisos = [];
  const hallazgos = [];

  // --- 1. El archivo declara lo que hace falta para comprobarlo -------------
  //
  // Nada de `?? []` acá: si al archivo le falta un bloque, no se puede
  // comprobar lo que ese bloque describe, y una comprobación que no ocurrió no
  // se anuncia como comprobación limpia.
  const tablasCabecera = exigirArreglo(cabecera?.esquema?.tablas, "el esquema de sus tablas", "El respaldo");
  const fksCabecera = exigirArreglo(cabecera?.esquema?.fks, "el bloque de llaves foráneas", "El respaldo");
  const migracionesCabecera = exigirArreglo(cabecera?.migraciones, "la lista de migraciones", "El respaldo");
  const esquemaRespaldo = new Map(tablasCabecera.map((t) => [t.nombre, t]));

  // --- 2. Migraciones: ¿el repo sigue siendo el de entonces? ----------------
  if (base) {
    for (const nota of base.notas) avisos.push(nota);
    const enRepo = new Map(base.todas.map((m) => [m.archivo, m.sha256]));
    const enRespaldo = new Map(migracionesCabecera.map((m) => [m.archivo, m.sha256]));
    const nuevas = [...enRepo.keys()].filter((a) => !enRespaldo.has(a));
    const cambiadas = [...enRespaldo.keys()].filter((a) => enRepo.has(a) && enRepo.get(a) !== enRespaldo.get(a));
    const perdidas = [...enRespaldo.keys()].filter((a) => !enRepo.has(a));
    if (nuevas.length > 0) avisos.push(`Migraciones nuevas en el repo desde el respaldo: ${nuevas.join(", ")}`);

    // Una migración que cambia no siempre es un problema, y tratar los dos casos
    // igual enseña a ignorar el rojo. Lo que importa es si la migración PARTICIPÓ
    // en el esquema contra el que se está restaurando:
    //
    //   - Sí participó (está en la cadena que construyó el destino): el esquema
    //     de hoy ya no es el de cuando se sacó el respaldo. Eso invalida el
    //     ensayo y va como problema.
    //   - No participó (es posterior al respaldo, todavía pendiente): que cambie
    //     es lo normal mientras alguien la escribe. Va como aviso, porque igual
    //     cambia lo que va a pasar en el paso 10.
    const enLaCadena = new Set(base.aplicadas.map((m) => m.archivo));
    const cambiadasEnCadena = cambiadas.filter((a) => enLaCadena.has(a));
    const cambiadasPendientes = cambiadas.filter((a) => !enLaCadena.has(a));
    if (cambiadasEnCadena.length > 0) {
      problemas.push(
        "Migraciones CAMBIADAS desde el respaldo que SÍ forman el esquema del ensayo " +
          `(0001-0038 están congeladas): ${cambiadasEnCadena.join(", ")}`,
      );
    }
    if (cambiadasPendientes.length > 0) {
      avisos.push(
        `Migraciones pendientes que cambiaron desde el respaldo: ${cambiadasPendientes.join(", ")}. ` +
          "No tocan el esquema del ensayo (son posteriores), pero sí lo que se aplica encima al final.",
      );
    }
    if (perdidas.length > 0) {
      problemas.push(`Migraciones que el respaldo conoce y el repo ya no tiene: ${perdidas.join(", ")}`);
    }
  }

  // --- 3. El esquema del destino contra el del respaldo ---------------------
  let esquemaDestino;
  try {
    esquemaDestino = (await ejecutor.ejecutar(SQL_ESQUEMA))[0].esquema;
  } catch (e) {
    throw new AbortoDeRestauracion(
      `No se pudo leer el esquema del destino: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const tablasDestino = new Map(esquemaDestino.tablas.map((t) => [t.nombre, t]));
  const faltantes = [];
  const bloqueos = [];
  // Lo comparado y lo saltado se cuentan por separado. `tablasCabecera.length`
  // incluía `auth.users`, que este bucle salta en la línea de abajo: la corrida
  // anunciaba «83 tablas comprobadas» habiendo comparado 82. Lo que no se
  // comparó se declara no comparado; jamás se suma al verde.
  const comparadas = [];
  const noComparadas = [];

  for (const t of tablasCabecera) {
    const esquemaTabla = t.esquema ?? "public";
    if (esquemaTabla !== "public") {
      // `SQL_ESQUEMA` sólo lee `public`, así que no hay contra qué comparar
      // `auth.users`. Eso no la hace comprobada: la hace NO comprobada.
      noComparadas.push(`${esquemaTabla}.${t.nombre}`);
      continue;
    }
    const destino = tablasDestino.get(t.nombre);
    if (!destino) {
      faltantes.push(`falta la tabla ${t.nombre}`);
      continue;
    }
    comparadas.push(t.nombre);
    const colsDestino = new Map(destino.columnas.map((c) => [c.nombre, c]));
    for (const c of t.columnas) {
      const d = colsDestino.get(c.nombre);
      if (!d) faltantes.push(`${t.nombre}.${c.nombre} no existe en el destino`);
      else if (d.tipo !== c.tipo) {
        faltantes.push(`${t.nombre}.${c.nombre} es ${c.tipo} en el respaldo y ${d.tipo} en el destino`);
      }
    }
    // Columnas que el destino tiene de más. Hay dos casos muy distintos:
    //
    //   - obligatoria y SIN valor por defecto: el INSERT no puede correr. Y no
    //     hay nada que inventar ahí: si la columna existe y es obligatoria, es
    //     porque alguien decidió que ese dato hay que declararlo. Rellenarlo con
    //     un valor cómodo sería exactamente lo que la migración vino a prohibir.
    //   - el resto: entra, pero la fila restaurada queda con el valor por
    //     defecto de la columna, que NO es lo que la persona tenía.
    const delRespaldo = new Set(t.columnas.map((c) => c.nombre));
    const extra = destino.columnas.filter((c) => !delRespaldo.has(c.nombre) && !c.derivada);
    const obligatoriasSinDefecto = extra.filter((c) => c.obligatoria && !c.con_default);
    if (obligatoriasSinDefecto.length > 0) {
      bloqueos.push(
        `${t.nombre}: el destino exige ${obligatoriasSinDefecto.map((c) => c.nombre).join(", ")} y el respaldo no trae esa columna.`,
      );
    }
    if (extra.length > obligatoriasSinDefecto.length) {
      const resto = extra.filter((c) => !obligatoriasSinDefecto.includes(c)).map((c) => c.nombre);
      avisos.push(
        `${t.nombre}: el destino tiene columnas que el respaldo no trae (quedan en su valor por defecto): ${resto.join(", ")}`,
      );
    }
  }

  const tablasNuevasEnDestino = esquemaDestino.tablas
    .map((t) => t.nombre)
    .filter((n) => !esquemaRespaldo.has(n));
  if (tablasNuevasEnDestino.length > 0) {
    avisos.push(`El destino tiene tablas que el respaldo no conoce (quedan vacías): ${tablasNuevasEnDestino.join(", ")}`);
  }

  if (faltantes.length > 0) {
    throw new AbortoDeRestauracion(
      [
        "EL DESTINO NO PUEDE RECIBIR ESTE RESPALDO: le falta esquema.",
        ...faltantes.map((f) => `  - ${f}`),
        "",
        "Aplica primero las migraciones que le falten al destino y vuelve a intentar.",
        "Restaurar así perdería datos en silencio, y eso no se hace.",
      ].join(SALTO),
    );
  }
  if (bloqueos.length > 0) {
    throw new AbortoDeRestauracion(
      [
        "EL DESTINO VA MÁS ADELANTE QUE EL RESPALDO Y NO SE PUEDE CARGAR ASÍ.",
        ...bloqueos.map((b) => `  - ${b}`),
        "",
        "Esas columnas son obligatorias y no tienen valor por defecto: alguien decidió",
        "que ese dato hay que declararlo, y el respaldo es de antes de esa decisión.",
        "Inventarles un valor cómodo sería justo lo que esa migración vino a prohibir.",
        "",
        "El orden correcto es al revés:",
        "  1. Un destino con el esquema del respaldo (las migraciones hasta ese punto).",
        "  2. Cargar los datos.",
        "  3. RECIÉN AHÍ aplicar las migraciones nuevas, que traen su propio relleno",
        "     declarado para las filas viejas.",
        "",
        "Detalle en docs/deployment/respaldo-y-restauracion.md",
      ].join(SALTO),
    );
  }

  log(`Esquema del destino compatible: ${comparadas.length} tablas comprobadas.`);
  if (noComparadas.length > 0) {
    log(
      `  Fuera de la comparación (el esquema del destino sólo se lee de public): ${noComparadas.join(", ")}.`,
    );
  }

  // --- 4. ¿El destino ya tiene datos? --------------------------------------
  const nombresPublic = tablasCabecera
    .filter((t) => (t.esquema ?? "public") === "public")
    .map((t) => t.nombre);

  const antes = new Map();
  for (let i = 0; i < nombresPublic.length; i += 40) {
    // Se parte en tandas: 80 `union all` en una consulta anda bien, pero la
    // Management API no promete nada sobre el tamaño de la sentencia.
    const sql = nombresPublic
      .slice(i, i + 40)
      .map((n) => `select ${literal(n)}::text as tabla, count(*)::text as n from public.${ident(n)}`)
      .join(" union all ");
    for (const f of await ejecutor.ejecutar(sql)) antes.set(f.tabla, Number(f.n));
  }
  const conDatos = [...antes.entries()].filter(([, n]) => n > 0);
  if (alDetectarDatos) alDetectarDatos(conDatos);

  // --- 5. El permiso para apagar las FK, ANTES de borrar nada --------------
  const sonda = await comprobarPermisoDeReplicacion(ejecutor);
  if (!sonda.permitido) {
    throw new AbortoDeRestauracion([AYUDA_SIN_PERMISO, "", `Motivo exacto: ${sonda.motivo}`].join(SALTO));
  }
  log(
    `Puede apagar la integridad referencial para cargar: sí (rol ${sonda.detalle?.rol ?? "?"}` +
      `, superusuario ${sonda.detalle?.superusuario ?? "?"}).`,
  );
  // La sonda subió `session_replication_role` a `replica` para poder mirarlo. Si
  // no se pudo devolver a `origin`, la sesión quedó con los disparadores
  // apagados y eso se DICE: nadie tiene que deducirlo de un comentario.
  if (sonda.restablecido !== true) {
    avisos.push(
      "La sonda no pudo devolver session_replication_role a origin" +
        `${sonda.motivoRestablecer ? `: ${sonda.motivoRestablecer}` : ""}. ` +
        "Si esta conexión se reusa, las sentencias siguientes corren con los disparadores apagados.",
    );
  }

  // --- 6. Identidades: a quién apunta cada household_members.user_id --------
  //
  // Las columnas que apuntan a `auth.users` se deducen de las llaves foráneas
  // del respaldo (hoy `household_members.user_id` e `invitations.accepted_by`)
  // para que mañana no haya que acordarse.
  const columnasDeUsuario = fksCabecera
    .filter((fk) => fk.padre_esquema === "auth" && fk.padre === "users")
    .map((fk) => ({ tabla: fk.hijo, columna: fk.cols_hijo[0] }));

  const bloqueUsuarios = porNombre.get("users");
  if (!bloqueUsuarios) {
    throw new AbortoDeRestauracion(
      [
        "El respaldo no trae el bloque `auth.users`.",
        "Sin él no se sabe a qué personas apuntaban las fichas: cero cuentas y «no hacía",
        "falta reenlazar nada» se verían igual, y son cosas distintas. Saca un respaldo nuevo.",
      ].join(SALTO),
    );
  }
  const usuariosRespaldo = bloqueUsuarios.datos;

  let mapaUsuarios = new Map(usuariosRespaldo.map((u) => [u.id, u.id]));
  let huboReenlace = false;

  if (modo === "real") {
    // En un proyecto nuevo las cuentas se crean por Supabase Auth y traen ids
    // NUEVOS: el respaldo no puede reponer credenciales (a propósito). Se
    // reenlaza por correo, y CADA reenlace se imprime. Un remapeo silencioso
    // sería peor que fallar: nadie se enteraría de que la ficha médica quedó
    // colgando de otra cuenta.
    const enDestino = await ejecutor.ejecutar("select id::text as id, email from auth.users");
    const porCorreo = new Map(enDestino.filter((u) => u.email).map((u) => [u.email.toLowerCase(), u.id]));
    const idsDestino = new Set(enDestino.map((u) => u.id));
    const sinResolver = [];

    mapaUsuarios = new Map();
    for (const u of usuariosRespaldo) {
      if (idsDestino.has(u.id)) {
        mapaUsuarios.set(u.id, u.id);
        continue;
      }
      const porMail = u.email ? porCorreo.get(u.email.toLowerCase()) : null;
      if (porMail) {
        mapaUsuarios.set(u.id, porMail);
        huboReenlace = true;
        log(`  Reenlace de cuenta: ${u.email} ${u.id} -> ${porMail}`);
        continue;
      }
      sinResolver.push(u);
    }

    if (sinResolver.length > 0) {
      throw new AbortoDeRestauracion(
        [
          "Hay cuentas del respaldo que NO existen en el proyecto destino:",
          ...sinResolver.map((u) => `  - ${u.email ?? "(sin correo)"} (id ${u.id})`),
          "",
          "El respaldo no guarda credenciales a propósito (auth.users trae hashes de",
          "contraseña y tokens de recuperación). Crea esas cuentas en Supabase Auth con",
          "EL MISMO CORREO y vuelve a correr: el reenlace por correo es automático.",
          "",
          "Restaurar sin resolverlas dejaría fichas médicas apuntando a nadie.",
        ].join(SALTO),
      );
    }
  }

  // Con qué id queda cada cuenta EN EL DESTINO. Se devuelve para que el ensayo
  // en seco pueda sembrar un Postgres desechable con los mismos ids que tiene
  // producción y correr ahí las sentencias que se generaron para ella.
  //
  // El `?? null` NO es un relleno cómodo: acá arriba la restauración ya abortó
  // si alguna cuenta quedó sin resolver, así que un null sería un imposible. Se
  // deja explícito —y no `?? u.id`, que inventaría— para que quien lo consuma
  // se plante en vez de sembrar una ficha médica con el id equivocado.
  const cuentasDestino = usuariosRespaldo.map((u) => ({
    id: mapaUsuarios.get(u.id) ?? null,
    email: u.email ?? null,
    created_at: u.created_at ?? null,
  }));

  // --- 7. El plan completo, con la base todavía intacta --------------------
  const orden = [
    // auth.users primero: todo lo demás cuelga de ahí. En el destino real no se
    // toca (las cuentas las crea Supabase Auth); en el ensayo sí, porque la base
    // desechable nace sin nadie.
    ...(modo === "ensayo" ? ["users"] : []),
    ...nombresPublic,
  ];
  const plan = planDeCarga({ orden, esquemaRespaldo, porNombre, columnasDeUsuario, mapaUsuarios });

  // --- 8. Cargar ------------------------------------------------------------
  log("");
  log(seco ? "Generando las sentencias (EN SECO: no se escribe nada)…" : "Restaurando…");

  for (const paso of plan) {
    try {
      await ejecutor.escribir(paso.sql);
    } catch (e) {
      throw new AbortoDeRestauracion(
        [
          `FALLÓ AL RESTAURAR ${paso.tabla} (${paso.filas.length} filas).`,
          `  ${e instanceof Error ? e.message : String(e)}`,
          "",
          modo === "real"
            ? "La base quedó A MEDIO RESTAURAR. NO la dejes así: revisa el error y vuelve a correr la restauración completa."
            : "El ensayo se detuvo acá. El respaldo NO está probado.",
        ].join(SALTO),
      );
    }
  }

  // El `replica` va en el preámbulo de CADA sentencia porque la Management API
  // no promete que dos llamadas caigan en la misma conexión. Éste es el cierre
  // simétrico de la CARGA: va por `escribir` a propósito, porque pertenece al
  // tramo que el modo en seco no ejecuta y sí declara en su lista de sentencias.
  // El de la SONDA es otro y va por `ejecutar` (ver `comprobarPermisoDeReplicacion`):
  // ese sí tiene que ocurrir en seco, porque la sonda sí se envía en seco.
  try {
    await ejecutor.escribir(SQL_RESET_REPLICACION);
  } catch (e) {
    avisos.push(`No se pudo devolver session_replication_role a origin: ${e}`);
  }

  log(`  ${plan.length} tablas ${seco ? "planificadas" : "restauradas"}.`);

  // La aritmética del veredicto, calculada donde se sabe la verdad.
  //
  // `cierre.filas` es el total del ARCHIVO e incluye `auth.users`, que en modo
  // real NO se restaura a propósito (las cuentas las crea Supabase Auth). Decir
  // «RESTAURACIÓN OK: <cierre.filas> filas en <plan.length> tablas» sumaba al
  // verde filas que nadie escribió, con las dos cifras sacadas de universos
  // distintos. Acá las filas salen del MISMO plan que las tablas, y lo que
  // quedó fuera se nombra en vez de desaparecer.
  const filasCargadas = plan.reduce((total, paso) => total + paso.filas.length, 0);
  const enElPlan = new Set(plan.map((p) => p.tabla));
  const tablasFueraDelPlan = tablas
    .filter((b) => !enElPlan.has(b.nombre))
    .map((b) => ({ tabla: `${b.esquema ?? "public"}.${b.nombre}`, filas: b.filas }));

  if (seco) {
    // Nada se escribió, así que releer el destino compararía el respaldo contra
    // los datos VIEJOS. Un rojo ahí no significaría nada y un verde tampoco: lo
    // honesto es no verificar y decir exactamente qué quedó sin comprobar.
    log("");
    log("MODO EN SECO. Lo que quedó comprobado y lo que NO:");
    log("  SÍ: el esquema del destino recibe este respaldo.");
    log("  SÍ: el destino permite apagar la integridad referencial para cargar.");
    log("  SÍ: cada cuenta del respaldo tiene su cuenta en el destino (reenlace resuelto).");
    log("  SÍ: las sentencias de carga se generan enteras, sin ids de usuario sin resolver.");
    log("  NO: nada se escribió, así que NO se comprobó que los datos vuelvan idénticos.");
    log("      Eso lo prueba el ensayo en PGlite y la prueba automatizada del camino real.");
    return {
      ok: problemas.length === 0,
      problemas,
      avisos,
      hallazgos,
      plan,
      seco: true,
      conDatos,
      cuentasDestino,
      filasCargadas,
      tablasFueraDelPlan,
      esquemaComparadas: comparadas.length,
      esquemaNoComparadas: noComparadas,
    };
  }

  // --- 9. Verificar: hashes, huérfanos ------------------------------------
  log("");
  log("Verificando…");

  const definiciones = plan.map((p) => p.definicion);
  const leido = new Map();
  for (let i = 0; i < definiciones.length; i += 25) {
    const sql = definiciones
      .slice(i, i + 25)
      .map((t) => {
        const esquema = t.esquema ?? "public";
        return (
          `select ${literal(t.nombre)}::text as tabla, ` +
          `(select coalesce(jsonb_agg(${expresionFila(t)} order by ${ordenDe(t)}), '[]'::jsonb) ` +
          `from ${ident(esquema)}.${ident(t.nombre)} t) as filas`
        );
      })
      .join(" union all ");
    try {
      for (const fila of await ejecutor.ejecutar(sql)) leido.set(fila.tabla, fila.filas);
    } catch (e) {
      throw new AbortoDeRestauracion(
        `No se pudo releer el destino para verificar: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  let tablasOk = 0;
  for (const paso of plan) {
    const definicion = paso.definicion;
    const declarado = porNombre.get(definicion.nombre);
    const filasLeidas = leido.get(definicion.nombre);
    if (!Array.isArray(filasLeidas)) {
      problemas.push(`${definicion.nombre}: el destino no devolvió filas al releer.`);
      continue;
    }
    if (filasLeidas.length !== declarado.filas) {
      problemas.push(
        `${definicion.nombre}: el respaldo trae ${declarado.filas} fila(s) y el destino quedó con ${filasLeidas.length}.`,
      );
      continue;
    }

    const cols = columnasGuardadas(definicion);

    // Dos comparaciones distintas, y las dos importan:
    //
    //  a) el archivo contra sí mismo: el hash que la línea de la tabla declara
    //     tiene que salir de las filas que esa misma línea trae. Si no, el
    //     archivo miente sobre su propio contenido.
    //  b) lo que quedó en el destino contra lo que se ENVIÓ. Antes, cuando había
    //     reenlace de cuentas, esta comparación se saltaba y la tabla se sumaba
    //     igual al conteo de «hash idéntico»: UNKNOWN presentado como NORMAL,
    //     justo en household_members e invitations, que son las que llevan la
    //     identidad de la ficha clínica. Hoy se le aplica el MISMO reenlace a
    //     las filas esperadas y se compara de verdad.
    const hashDeclarado = hashDeFilas(declarado.datos, cols);
    if (hashDeclarado !== declarado.sha256) {
      problemas.push(
        [
          `${definicion.nombre}: el ARCHIVO no calza consigo mismo.`,
          `    declarado: ${declarado.sha256}`,
          `    sus filas: ${hashDeclarado}`,
        ].join(SALTO),
      );
      continue;
    }

    const hashEsperado = hashDeFilas(paso.filas, cols);
    const hashDestino = hashDeFilas(filasLeidas, cols);
    if (hashDestino !== hashEsperado) {
      problemas.push(
        [
          `${definicion.nombre}: los datos VOLVIERON DISTINTOS.`,
          `    esperado: ${hashEsperado}`,
          `    destino:  ${hashDestino}`,
        ].join(SALTO),
      );
      continue;
    }
    tablasOk += 1;
  }

  log(`  Hash idéntico en ${tablasOk}/${plan.length} tablas.`);
  if (huboReenlace) {
    log("    (las tablas con cuentas reenlazadas se comparan contra las filas YA reenlazadas)");
  }

  // -- Huérfanos: las FK se apagaron para cargar, hay que mirarlas ----------
  const fks = fksCabecera.filter((fk) => {
    if (fk.padre_esquema === "auth" && fk.padre === "users") return true;
    if (fk.padre_esquema === "auth") return modo === "ensayo";
    return fk.padre_esquema === "public";
  });

  let huerfanosTotales = 0;
  let fksComprobadas = 0;
  for (let i = 0; i < fks.length; i += 40) {
    const tanda = fks.slice(i, i + 40);
    const sql = tanda
      .map((fk) => {
        const noNulos = fk.cols_hijo.map((c) => `h.${ident(c)} is not null`).join(" and ");
        const enlace = fk.cols_hijo
          .map((c, i2) => `p.${ident(fk.cols_padre[i2])} = h.${ident(c)}`)
          .join(" and ");
        return (
          `select ${literal(fk.nombre)}::text as fk, count(*)::text as n ` +
          `from public.${ident(fk.hijo)} h where ${noNulos} and not exists (` +
          `select 1 from ${ident(fk.padre_esquema)}.${ident(fk.padre)} p where ${enlace})`
        );
      })
      .join(" union all ");
    let filas;
    try {
      filas = await ejecutor.ejecutar(sql);
    } catch (e) {
      problemas.push(`No se pudo comprobar huérfanos: ${e instanceof Error ? e.message : String(e)}`);
      break;
    }
    fksComprobadas += tanda.length;
    for (const f of filas) {
      const n = Number(f.n);
      if (n > 0) {
        huerfanosTotales += n;
        problemas.push(`Llave foránea ${f.fk}: ${n} fila(s) apuntan a algo que no existe.`);
      }
    }
  }
  if (fksComprobadas < fks.length) {
    problemas.push(
      `Sólo se alcanzaron a comprobar ${fksComprobadas} de ${fks.length} llaves foráneas: el resto quedó SIN MIRAR.`,
    );
  }
  log(`  Llaves foráneas comprobadas: ${fksComprobadas} de ${fks.length} · huérfanos: ${huerfanosTotales}`);

  // -- Lo clínico, contado en voz alta -------------------------------------
  const clinico = TABLAS_CLINICAS.map((n) => ({ tabla: n, filas: porNombre.get(n)?.filas ?? null })).filter(
    (c) => c.filas !== null && c.filas > 0,
  );
  if (clinico.length > 0) {
    log("  Datos clínicos restaurados:");
    for (const c of clinico) log(`    - ${c.tabla}: ${c.filas} fila(s)`);
  }

  // -- Los PDF de los exámenes NO están en el respaldo ----------------------
  const bloqueDocs = porNombre.get("lab_documents");
  const conArchivo = bloqueDocs ? bloqueDocs.datos.filter((d) => d.storage_path) : [];
  const inventario = cabecera.storage ?? { estado: "DESCONOCIDO" };

  if (conArchivo.length > 0) {
    avisos.push(
      `${conArchivo.length} documento(s) de lab_documents apuntan a un archivo del bucket. ` +
        "Ese PDF NO viaja en este respaldo: hay que bajarlo aparte desde Storage.",
    );
  }
  if (inventario.estado === "LEIDO") {
    const objetos = exigirArreglo(inventario.objetos, "el inventario de Storage que dice haber leído", "El respaldo");
    const nombres = new Set(objetos.map((o) => o.nombre));
    const colgando = conArchivo.filter((d) => !nombres.has(d.storage_path));
    log(`  Storage al momento del respaldo: ${objetos.length} archivo(s) inventariado(s).`);
    if (colgando.length > 0) {
      // Esto no lo rompe la restauración: ya estaba roto en producción. Vale la
      // pena decirlo igual, porque es una ficha médica sin su examen.
      avisos.push(
        `${colgando.length} fila(s) de lab_documents apuntan a un archivo que NO estaba en el bucket cuando se sacó el respaldo.`,
      );
    }
  } else {
    avisos.push(
      "El inventario de Storage quedó DESCONOCIDO en el respaldo: no se sabe cuántos archivos clínicos hay. No asumas cero.",
    );
  }

  // --- 10. Las migraciones posteriores, sobre los datos ya restaurados -----
  //
  // El runbook dice «carga los datos y DESPUÉS aplica las migraciones nuevas».
  // Este paso prueba justamente ese último tramo, con las filas reales adentro:
  // es la única forma de saber que el relleno declarado de la 0038 y compañía
  // aguanta los datos de la familia y no sólo los del seed de pruebas.
  //
  // Si una migración pendiente falla acá, el RESPALDO igual sirve: lo que está
  // roto es la migración. Por eso se informa fuerte pero no invalida el ensayo —
  // dejar a la familia sin respaldo por un problema de otra cosa sería el peor
  // de los dos errores.
  if (modo === "ensayo" && aplicarPendientes && base && base.sobrantes.length > 0) {
    log("");
    log(`Aplicando las ${base.sobrantes.length} migraciones posteriores sobre los datos restaurados…`);
    const pendientes = base.todas.filter((m) => base.sobrantes.includes(m.archivo));
    for (const m of pendientes) {
      try {
        await base.db.exec(m.sql);
        log(`  ok  ${m.archivo}`);
      } catch (e) {
        hallazgos.push(
          [
            `La migración pendiente ${m.archivo} NO aplica sobre los datos reales de producción.`,
            `    ${e instanceof Error ? e.message : String(e)}`,
            "    (el respaldo está bien; lo que hay que arreglar es la migración, ANTES de aplicarla en vivo)",
          ].join(SALTO),
        );
        break; // las siguientes suponen ésta aplicada: seguir sólo daría ruido
      }
    }
  }

  return {
    ok: problemas.length === 0,
    problemas,
    avisos,
    hallazgos,
    plan,
    seco: false,
    conDatos,
    cuentasDestino,
    huboReenlace,
    tablasOk,
    fksComprobadas,
    huerfanos: huerfanosTotales,
    // `filas` es lo que el ARCHIVO declara; `filasCargadas` es lo que este
    // camino escribió de verdad. En modo real no son el mismo número y no se
    // pueden intercambiar: quien anuncie un OK tiene que usar el segundo.
    filas: cierre.filas,
    filasCargadas,
    tablasFueraDelPlan,
    esquemaComparadas: comparadas.length,
    esquemaNoComparadas: noComparadas,
  };
}
