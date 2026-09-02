import type { SupabaseClient } from "@supabase/supabase-js";
import { requireActor } from "@/lib/auth/actor";
import type { CapabilitiesRpc } from "@/lib/auth/actor";
import { runActionTool, runReadTool } from "./run-tool";
import type { ReadContext, ReadTool, ToolPayload } from "./tool";
import { ConfirmationGrant, claimProposal, crearAlmacenEnMemoria } from "./proposal";
import {
  ANA,
  LOTE_77,
  SIN_EXIGENCIA,
  SIN_GESTO,
  actorDePrueba,
  capacidadesFalsas,
  herramientaAccion,
  herramientaLectura,
  propuestaDePrueba,
  sesionAccion,
  sesionLectura,
} from "./dobles-de-prueba";

/**
 * EL CATÁLOGO DE LO QUE NO COMPILA.
 *
 * Cada `@ts-expect-error` de acá es una prueba con dientes: si alguien afloja la
 * compuerta —hace opcional el permiso, deja `insert` al alcance de una lectura,
 * permite declarar una acción no idempotente— el error desaparece, la directiva
 * queda sin usar y `tsc` falla con "Unused '@ts-expect-error' directive". O sea:
 * este archivo se rompe cuando el arreglo se revierte, que es lo único que hace
 * que una prueba valga.
 *
 * Corre en `npm run typecheck` (está bajo `src`) y también dentro de
 * `superficie.test.ts`, que invoca al compilador de verdad.
 *
 * Nada de acá se ejecuta: son declaraciones para el compilador.
 */

const ARGS = { lotId: LOTE_77, gramos: 2000 };

// ---------------------------------------------------------------------------
// 1. Una acción no se puede ejecutar sin la confirmación
// ---------------------------------------------------------------------------

export async function sinConfirmacionNoCompila(): Promise<unknown> {
  // Falta el cuarto argumento: {proposalId, acceptedByMemberId, confirmationToken}
  // viajan adentro de la ConfirmationGrant. No es un chequeo en runtime que se
  // pueda olvidar: es un parámetro que no está.
  // @ts-expect-error falta el cuarto argumento: sin ConfirmationGrant no hay ejecucion
  return runActionTool(herramientaAccion(), ARGS, sesionAccion());
}

// ---------------------------------------------------------------------------
// 2. Una confirmación no se puede fabricar
// ---------------------------------------------------------------------------

export function grantConNewNoCompila(): unknown {
  // @ts-expect-error el constructor es privado: la llave no se fabrica afuera
  return new ConfirmationGrant(propuestaDePrueba(), ANA, "2026-09-01T20:12:00.000Z");
}

export function grantComoLiteralNoCompila(): unknown {
  // @ts-expect-error copiar la forma no alcanza, la clase es nominal
  const inventada: ConfirmationGrant = { proposalId: "p", acceptedByMemberId: ANA, householdId: "h", accion: "qrUseLot", argsDigest: "d", dedupeKey: "k", otorgadoEn: "t", usar: () => true, yaUsado: false };
  return inventada;
}

/*
 * Un `as ConfirmationGrant` sobre un literal con la forma pública SÍ compila:
 * TypeScript permite la aserción cuando uno de los dos tipos es asignable al
 * otro, y la clase (con su campo privado de más) es asignable al literal. El
 * campo privado bloquea la asignación implícita —que es la que se cuela sin que
 * nadie la note— y para el casteo deliberado está la guarda de fuente de
 * `superficie.test.ts`: castear a ConfirmationGrant fuera de proposal.ts hace
 * fallar el CI. Se deja escrito acá porque un candado que uno cree tener y no
 * tiene es peor que no tenerlo.
 */

/** El resultado fallido no trae `grant`: no hay rama que devuelva una a medias. */
export async function grantDeUnFalloNoCompila(): Promise<unknown> {
  const salida = await claimProposal(
    { proposalId: "p", acceptedByMemberId: ANA, confirmationToken: "t", segundoGesto: SIN_GESTO },
    {
      store: crearAlmacenEnMemoria(),
      actor: actorDePrueba(),
      revalidar: async () => ({ veredicto: "IGUAL" }),
      exigirSegundoGesto: SIN_EXIGENCIA,
      ahora: "2026-09-01T20:12:00.000Z",
    },
  );
  // @ts-expect-error el resultado fallido no trae grant
  return salida.grant;
}

// ---------------------------------------------------------------------------
// 3. Leer y actuar son caminos disjuntos
// ---------------------------------------------------------------------------

export async function accionPorElCaminoDeLecturaNoCompila(): Promise<unknown> {
  // @ts-expect-error una accion no entra por el camino de lectura
  return runReadTool(herramientaAccion(), ARGS, sesionLectura());
}

export async function lecturaConSesionDeAccionNoCompila(): Promise<unknown> {
  // @ts-expect-error la sesion de accion no sirve para leer
  return runReadTool(herramientaLectura(), { lotId: LOTE_77 }, sesionAccion());
}

/** El registry del router tiene tipo de solo lectura: un ACT no entra. */
export function registryConAccionNoCompila(): unknown {
  // @ts-expect-error un ACT no cabe donde se declara una lectura
  const entrada: ReadTool<never, unknown> = herramientaAccion();
  return entrada;
}

// ---------------------------------------------------------------------------
// 4. Las declaraciones incoherentes no existen
// ---------------------------------------------------------------------------

export function lecturaConAccionNoCompila(): unknown {
  // @ts-expect-error una lectura no declara accion
  return herramientaLectura({ accion: "discardLot" });
}

export function lecturaQueEscribeNoCompila(): unknown {
  // @ts-expect-error una lectura no declara un efecto de escritura
  return herramientaLectura({ effect: "WRITES_LEDGER" });
}

export function accionSinEfectoNoCompila(): unknown {
  // @ts-expect-error una accion no declara efecto NONE
  return herramientaAccion({ effect: "NONE" });
}

export function accionSinIdempotenciaNoCompila(): unknown {
  // @ts-expect-error NOT_IDEMPOTENT no existe para una accion
  return herramientaAccion({ idempotency: { mode: "NOT_IDEMPOTENT", motivo: "inserta siempre" } });
}

// ---------------------------------------------------------------------------
// 5. Una lectura no tiene con qué escribir
// ---------------------------------------------------------------------------

export function lecturaNoPuedeInsertar(ctx: ReadContext): unknown {
  // @ts-expect-error insert no existe en ReadOnlyDb
  return ctx.db.insert({ household_id: "x" });
}

export function lecturaNoPuedeActualizar(ctx: ReadContext): unknown {
  // @ts-expect-error update no existe en ReadOnlyDb
  return ctx.db.update({ status: "DISCARDED" });
}

export function lecturaNoPuedeBorrar(ctx: ReadContext): unknown {
  // @ts-expect-error delete no existe en ReadOnlyDb
  return ctx.db.delete();
}

export function lecturaNoPuedeUpsert(ctx: ReadContext): unknown {
  // @ts-expect-error upsert no existe en ReadOnlyDb
  return ctx.db.upsert({ id: "x" });
}

export function lecturaNoLlamaAccionesNoCompila(ctx: ReadContext): unknown {
  // @ts-expect-error callAction no existe en ReadOnlyDb
  return ctx.db.callAction("discardLot", {}, "k");
}

export function rpcFueraDeLaListaBlancaNoCompila(ctx: ReadContext): unknown {
  // `ensure_weekly_plan` crea una semana entera: preguntar nunca ejecuta.
  // @ts-expect-error ensure_weekly_plan no esta en la lista blanca de lectura
  return ctx.db.rpc("ensure_weekly_plan", { p_household_id: "x" });
}

// ---------------------------------------------------------------------------
// 6. Una acción no se llama sin clave de dedupe
// ---------------------------------------------------------------------------

export function accionSinDedupeKeyNoCompila(): unknown {
  return herramientaAccion({
    run: async (ctx) => {
      // @ts-expect-error callAction exige la clave de dedupe
      await ctx.db.callAction("qrUseLot", { lotId: LOTE_77 });
      throw new Error("inalcanzable");
    },
  });
}

// ---------------------------------------------------------------------------
// 7. El hogar es obligatorio: nada de caer al más antiguo
// ---------------------------------------------------------------------------

export async function actorSinHogarNoCompila(): Promise<unknown> {
  // @ts-expect-error requireActor exige el hogar
  return requireActor(capacidadesFalsas(actorDePrueba()));
}

// ---------------------------------------------------------------------------
// 8. El texto de la base no entra como si fuera propio
// ---------------------------------------------------------------------------

export function etiquetaSinMarcarNoCompila(): unknown {
  // @ts-expect-error una etiqueta cruda no es UntrustedText
  const payload: ToolPayload<number> = { data: 1, provenance: [], unknowns: [], reasons: [], labels: { [LOTE_77]: "Pollo" } };
  return payload;
}

// ---------------------------------------------------------------------------
// 9. Lo que SÍ tiene que compilar
// ---------------------------------------------------------------------------

/**
 * El cliente real satisface el puerto mínimo sin adaptador ni casteo. Si alguien
 * ensancha `CapabilitiesRpc` hasta pedir algo que el cliente no tiene, esto deja
 * de compilar antes de que la etapa 2 lo descubra a mano.
 */
export function elClienteRealSirveComoPuerto(db: SupabaseClient): CapabilitiesRpc {
  return db;
}
