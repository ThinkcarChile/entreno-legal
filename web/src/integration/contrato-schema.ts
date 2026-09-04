import { readFileSync } from "node:fs";
import path from "node:path";
import { levantarBase, MIGRACIONES, migracionesDeProduccion } from "./harness";
import { cargarLibroDeProduccion, sha256DeMigracion } from "./estado-produccion";

/**
 * EL CONTRATO DE SCHEMA, EN TRES ESTADOS Y NO EN DOS.
 *
 * Un objeto que la app necesita y producción no tiene puede serlo por razones que
 * no se parecen en nada, y meterlas en el mismo booleano es cómo se pierde la
 * protección: si todo es rojo, nada es rojo.
 *
 *   CONTRACT_DEFECT
 *     Nadie va a crear ese objeto, o quien dice crearlo no está en condiciones
 *     de hacerlo. Es el defecto original de este gate —la app pedía
 *     `meal_serving_record_items` y todo salía verde— y FALLA, siempre.
 *
 *   EXPECTED_PENDING_DEPLOYMENT
 *     Lo crea una migración escrita, sellada, con su checksum intacto, y que se
 *     DEMOSTRÓ que lo crea. Producción va atrás, que es el estado normal entre
 *     escribir una migración y que su dueño autorice aplicarla. CI puede pasar;
 *     el DESPLIEGUE queda bloqueado.
 *
 *   IN_SYNC
 *     Producción lo tiene. No hay nada que decir.
 *
 * LA DIFERENCIA MÁS IMPORTANTE CON LA VERSIÓN ANTERIOR: quién crea qué se
 * DEMUESTRA, no se adivina. Antes `migracionPendienteQueCrea` corría un regex
 * sobre el texto del archivo, y eso miente en las dos direcciones: un
 * `create table` adentro de un comentario o de una cadena calza sin crear nada,
 * y un objeto creado con `execute format(...)` dentro de un `do $$` no calza
 * aunque se cree de verdad. Un objeto mal clasificado como "ya viene en camino"
 * es exactamente el agujero que este archivo existe para tapar.
 *
 * Acá se levanta una base EN EL ESTADO DE PRODUCCIÓN, se aplican las pendientes
 * una por una, y después de cada una se mira qué apareció. Eso no es una
 * heurística: es la migración creando el objeto, observado.
 */

export type EstadoDeObjeto = "IN_SYNC" | "EXPECTED_PENDING_DEPLOYMENT" | "CONTRACT_DEFECT";

export interface ObjetoDelContrato {
  objeto: string;
  tipo: "tabla" | "funcion";
  estado: EstadoDeObjeto;
  /** La migración que se DEMOSTRÓ que lo crea, o null. */
  provisto_por: string | null;
  sellada: boolean;
  checksum: string | null;
  checksum_coincide: boolean;
  creacion_demostrada: boolean;
  usado_en: string[];
  /** Por qué NO es EXPECTED_PENDING_DEPLOYMENT. Vacío si lo es o si está en sync. */
  motivo: string | null;
}

export interface DemostracionDePendientes {
  /** objeto → migración que se vio crearlo. */
  creadoPor: Map<string, string>;
  /** Migraciones pendientes que NO se pudieron aplicar, con su error. */
  fallaronAlAplicar: { archivo: string; error: string }[];
  /** Las pendientes, en el orden del arnés. */
  pendientes: string[];
}

const RAIZ = path.resolve(__dirname, "../../..");

const SQL_RELACIONES = `select c.relname as nombre from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'v', 'm')`;

const SQL_FUNCIONES = `select p.proname as nombre from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'`;

/**
 * Aplica las pendientes sobre el estado real de producción y observa qué crea
 * cada una. Es caro (levanta una base y aplica migraciones) y por eso se llama
 * una vez por archivo de test, no una vez por objeto.
 *
 * Si una pendiente REVIENTA al aplicarse, no se detiene todo: se anota y se
 * sigue con las demás. Detenerse dejaría a las siguientes sin clasificar y el
 * informe diría "no sé" de cosas que sí se pueden saber. La que reventó hace
 * CONTRACT_DEFECT a todo lo que dependía de ella, que es lo correcto: una
 * migración que no aplica no está en camino a ninguna parte.
 */
export async function demostrarQueCreanLasPendientes(): Promise<DemostracionDePendientes> {
  const puestas = new Set(migracionesDeProduccion());
  const pendientes = MIGRACIONES.filter((m) => !puestas.has(m));

  const creadoPor = new Map<string, string>();
  const fallaronAlAplicar: { archivo: string; error: string }[] = [];
  if (pendientes.length === 0) return { creadoPor, fallaronAlAplicar, pendientes };

  const base = await levantarBase({ conSeeds: false, soloProduccion: true });
  try {
    const nombres = async (): Promise<Set<string>> => {
      const filas = await base.filas<{ nombre: string }>(
        `${SQL_RELACIONES} union all ${SQL_FUNCIONES}`,
      );
      return new Set(filas.map((f) => f.nombre));
    };

    let antes = await nombres();
    for (const archivo of pendientes) {
      try {
        await base.db.exec(readFileSync(path.join(RAIZ, archivo), "utf8"));
      } catch (e) {
        fallaronAlAplicar.push({
          archivo: archivo.split("/").pop() ?? archivo,
          error: e instanceof Error ? e.message : String(e),
        });
        continue;
      }
      const despues = await nombres();
      // EL NOMBRE, NO LA RUTA. El arnés lista "supabase/migrations/0061_x.sql" y
      // el libro indexa por "0061_x.sql". Guardar la ruta hacía que la búsqueda
      // en el libro fallara siempre y todo objeto pendiente cayera en
      // CONTRACT_DEFECT con el motivo "no tiene entrada en el libro" — una
      // acusación falsa contra una migración perfectamente sellada.
      const nombre = archivo.split("/").pop() ?? archivo;
      for (const n of despues) if (!antes.has(n)) creadoPor.set(n, nombre);
      antes = despues;
    }
  } finally {
    await base.cerrar();
  }
  return { creadoPor, fallaronAlAplicar, pendientes };
}

/**
 * Clasifica cada objeto que la app usa. Las siete condiciones del contrato
 * están acá, cada una con su motivo escrito: cuando algo cae en CONTRACT_DEFECT,
 * el informe dice CUÁL de las siete falló, no un "no cumple" genérico.
 */
export function clasificarObjetos(
  usos: Map<string, string[]>,
  tipo: "tabla" | "funcion",
  existentesEnProduccion: Set<string>,
  demostracion: DemostracionDePendientes,
  contratoDelSchemaFuturoPasa: boolean,
): ObjetoDelContrato[] {
  const libro = cargarLibroDeProduccion();
  const porArchivo = new Map(libro.entradas.map((e) => [e.archivo, e]));
  const fallaron = new Set(demostracion.fallaronAlAplicar.map((f) => f.archivo));

  return [...usos.entries()]
    .map(([objeto, usado_en]): ObjetoDelContrato => {
      // RUTAS NORMALIZADAS Y SIN REPETIR. `referencias()` devuelve rutas con el
      // separador del sistema y puede nombrar el mismo archivo dos veces (dos
      // consultas distintas al mismo objeto). Tal cual, el artefacto salía con
      // "eventos\\actions.ts" repetido en Windows y con "eventos/actions.ts" en
      // el Linux de CI: dos textos distintos para el mismo hecho, y el test de
      // "el artefacto está al día" se pondría rojo en CI para siempre sin que
      // nada hubiera cambiado. Se normaliza a barras y se deduplica.
      const base = {
        objeto,
        tipo,
        usado_en: [...new Set(usado_en.map((r) => r.split(String.fromCharCode(92)).join("/")))].sort(),
      };

      // (0) Producción lo tiene. No hay nada más que preguntar.
      if (existentesEnProduccion.has(objeto)) {
        return {
          ...base,
          estado: "IN_SYNC",
          provisto_por: null,
          sellada: false,
          checksum: null,
          checksum_coincide: false,
          creacion_demostrada: false,
          motivo: null,
        };
      }

      const defecto = (motivo: string, extra: Partial<ObjetoDelContrato> = {}): ObjetoDelContrato => ({
        ...base,
        estado: "CONTRACT_DEFECT",
        provisto_por: null,
        sellada: false,
        checksum: null,
        checksum_coincide: false,
        creacion_demostrada: false,
        motivo,
        ...extra,
      });

      // (1) y (5) Alguien tiene que crearlo, y hay que haberlo VISTO crearlo.
      const provisto_por = demostracion.creadoPor.get(objeto) ?? null;
      if (provisto_por === null) {
        return defecto(
          "ninguna migración pendiente lo crea: se aplicaron todas las pendientes sobre el " +
            "estado de producción y este objeto no apareció",
        );
      }

      // (6-bis) La migración que lo crea tiene que APLICARSE. Si reventó, no
      // está en camino a ninguna parte. (No puede pasar junto con lo de arriba
      // —una que revienta no crea nada— pero se comprueba igual: el día que el
      // orden cambie, prefiero un mensaje exacto a un imposible silencioso.)
      if (fallaron.has(provisto_por)) {
        return defecto(`${provisto_por} falla al aplicarse sobre el estado de producción`, {
          provisto_por,
        });
      }

      const entrada = porArchivo.get(provisto_por);
      if (entrada === undefined) {
        return defecto(`${provisto_por} no tiene entrada en el libro de producción`, { provisto_por });
      }

      // (2) Pendiente en el libro. Si el libro la da por aplicada y producción
      // no la tiene, el libro miente y eso no se tapa clasificando bonito.
      if (entrada.estado !== "PENDIENTE") {
        return defecto(
          `el libro declara ${provisto_por} como ${entrada.estado} pero producción no tiene el objeto`,
          { provisto_por },
        );
      }

      // (3) Sellada. Una pendiente sin checksum todavía se está escribiendo, y
      // apoyar la app en algo que aún cambia no es una brecha: es trabajo a
      // medias.
      if (entrada.sha256 === null) {
        return defecto(`${provisto_por} no está sellada: no tiene checksum en el libro`, {
          provisto_por,
        });
      }

      // (4) El checksum coincide con el archivo de HOY.
      //
      // En la práctica esto casi nunca se alcanza: `cargarLibroDeProduccion`
      // revienta ANTES con `EstadoDeProduccionDesconocido` y tumba el archivo de
      // pruebas entero, nombrando la migración y los dos hashes. Comprobado por
      // mutación. Se deja igual, y no es código muerto: esta función también se
      // llama desde contextos que no cargan el libro por esa puerta, y una
      // condición del contrato que dependa de que OTRO módulo la ataje primero
      // es una condición que un refactor borra sin que nadie lo note.
      const real = sha256DeMigracion(provisto_por);
      if (real !== entrada.sha256) {
        return defecto(
          `${provisto_por} cambió después de sellarse (libro ${entrada.sha256.slice(0, 12)}…, ` +
            `archivo ${real.slice(0, 12)}…)`,
          { provisto_por, sellada: true, checksum: entrada.sha256 },
        );
      }

      // (7) El contrato contra el schema futuro tiene que pasar. Si la cadena
      // completa no sostiene lo que la app pide, prometer que "ya viene" es
      // prometer algo que no existe ni siquiera en el repo.
      if (!contratoDelSchemaFuturoPasa) {
        return defecto(
          "el contrato contra la cadena completa NO pasa: el objeto no está garantizado ni en el repo",
          { provisto_por, sellada: true, checksum: entrada.sha256, checksum_coincide: true },
        );
      }

      return {
        ...base,
        estado: "EXPECTED_PENDING_DEPLOYMENT",
        provisto_por,
        sellada: true,
        checksum: entrada.sha256,
        checksum_coincide: true,
        creacion_demostrada: true,
        motivo: null,
      };
    })
    .sort((a, b) => a.objeto.localeCompare(b.objeto));
}

/** Una migración que el repo tiene y producción todavía no. */
export interface MigracionPendiente {
  archivo: string;
  sellada: boolean;
  checksum: string | null;
}

export interface EstadoDelContrato {
  proyecto: string;
  target_schema: "PASS" | "FAIL";
  production_schema: "IN_SYNC" | "BLOCKED_PENDING_DEPLOYMENT" | "CONTRACT_DEFECT";
  release_deployment_state: "READY" | "BLOCKED";
  /**
   * POR QUÉ está bloqueado, estructurado. Vacío sólo cuando está READY.
   *
   * Existe por un agujero real: el 2026-09-04 se aplicó la 0061 y el contrato
   * pasó a IN_SYNC / READY con la 0062 —el endurecimiento que le quita a `anon`
   * el EXECUTE sobre 269 funciones SECURITY DEFINER— todavía sin aplicar. El
   * contrato sólo miraba objetos que la APP REFERENCIA, y una postura de
   * seguridad no es un objeto referenciado: quedaba invisible. Producción atrás
   * del repo es una brecha de despliegue aunque el frontend no la note.
   */
  release_blocked_by: string[];
  /** Todo lo que el repo tiene y producción no, lo referencie la app o no. */
  pending_migrations: MigracionPendiente[];
  /**
   * Lo pone una persona a mano, y por eso existe: mientras
   * `release_deployment_state` sea BLOCKED, declararlo `true` pone rojo el
   * cierre pre-vuelo. Es el candado contra declarar Release Candidate de paso.
   */
  release_candidate_declarado: boolean;
  contract_defects: ObjetoDelContrato[];
  pending_objects: ObjetoDelContrato[];
}

export function armarEstadoDelContrato(
  objetos: ObjetoDelContrato[],
  targetSchemaPasa: boolean,
  releaseCandidateDeclarado: boolean,
  proyecto: string,
  pendientesDelLibro: MigracionPendiente[] = [],
): EstadoDelContrato {
  const contract_defects = objetos.filter((o) => o.estado === "CONTRACT_DEFECT");
  const pending_objects = objetos.filter((o) => o.estado === "EXPECTED_PENDING_DEPLOYMENT");

  const production_schema =
    contract_defects.length > 0
      ? "CONTRACT_DEFECT"
      : pending_objects.length > 0
        ? "BLOCKED_PENDING_DEPLOYMENT"
        : "IN_SYNC";

  // BLOQUEADO mientras haya UNA sola cosa pendiente, del tipo que sea. Que CI
  // pase no significa que se pueda lanzar: es exactamente la confusión que dejó
  // "CI verde con producción vieja" la última vez.
  const release_blocked_by: string[] = [];
  if (!targetSchemaPasa) release_blocked_by.push("TARGET_SCHEMA_FAIL");
  if (contract_defects.length > 0) release_blocked_by.push("CONTRACT_DEFECT");
  if (pending_objects.length > 0) release_blocked_by.push("PENDING_DEPLOYMENT_SCHEMA");
  // Y las migraciones pendientes que la app NO referencia: seguridad, permisos,
  // operación. Son las que se escapaban.
  for (const m of pendientesDelLibro) {
    release_blocked_by.push(`PENDING_MIGRATION_${m.archivo.slice(0, 4)}`);
  }

  return {
    proyecto,
    target_schema: targetSchemaPasa ? "PASS" : "FAIL",
    production_schema,
    release_deployment_state: release_blocked_by.length === 0 ? "READY" : "BLOCKED",
    release_blocked_by,
    release_candidate_declarado: releaseCandidateDeclarado,
    contract_defects,
    pending_objects,
    pending_migrations: pendientesDelLibro,
  };
}
