import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { parseRows, uuid, DataShapeError } from "@/lib/supabase/rows";
import { DataAccessError } from "@/lib/supabase/unwrap";
import type { AssistantProposal } from "@/domain/assistant/proposal";
import { EXISTING_ACTIONS, untrusted } from "@/domain/assistant/tool";
import type { Unknown } from "@/domain/assistant/tool";
import {
  esCodigoDeRazon,
  esSimboloDesconocido,
} from "@/domain/assistant/presentacion";
import type {
  CantidadEsperada,
  Medicion,
  PropuestaParaTarjeta,
} from "@/domain/assistant/presentacion";
import type { MedicalPermission } from "@/lib/auth/actor";

const PERMISOS_MEDICOS: readonly string[] = [
  "READ_LABS",
  "VIEW_CLINICAL_RESTRICTIONS",
  "CONFIRM_LABS",
];

function esPermisoMedico(v: unknown): v is MedicalPermission {
  return typeof v === "string" && PERMISOS_MEDICOS.includes(v);
}

type Db = SupabaseClient;

/**
 * Leer UNA propuesta para mostrar su tarjeta.
 *
 * La política de `assistant_proposals` (0053) ya decide quién la ve: el
 * `resumen` de una propuesta clínica dice cosas como "Sodio · máx 1500 mg", así
 * que la audiencia se evalúa con `capabilities_ok` en la base y no acá. Este
 * cargador solo valida la forma; si la fila no aparece, no se distingue "no
 * existe" de "no puedes verla", que es justo lo que hay que hacer para que la
 * pantalla no sea un oráculo.
 */

const accionGuardada = z.enum(EXISTING_ACTIONS);

const filaPropuesta = z.object({
  id: uuid,
  household_id: uuid,
  created_by: uuid,
  trace_id: z.string(),
  accion: accionGuardada,
  args: z.record(z.string(), z.unknown()),
  risk: z.enum(["BAJO", "MEDIO", "ALTO"]),
  effect: z.enum([
    "WRITES_PREFS",
    "WRITES_PLAN",
    "WRITES_LEDGER",
    "WRITES_MONEY",
    "WRITES_CLINICAL",
    "WRITES_GRANTS",
  ]),
  requires: z.array(z.record(z.string(), z.unknown())),
  dedupe_key: z.string(),
  basis: z.record(z.string(), z.unknown()),
  resumen: z.object({
    titulo: z.string(),
    lineas: z.array(z.object({ etiqueta: z.string(), valor: z.string() })).default([]),
    reasons: z
      .array(
        z.object({
          code: z.string(),
          params: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
        }),
      )
      .default([]),
    provenance: z
      .array(z.object({ motor: z.string(), version: z.string() }))
      .default([]),
    unknowns: z
      .array(z.object({ campo: z.string(), simbolo: z.string(), motivo: z.string() }))
      .default([]),
    irreversible: z.array(z.string()).default([]),
  }),
  status: z.enum([
    "OFFERED",
    "ACCEPTED",
    "EXECUTED",
    "REJECTED",
    "EXPIRED",
    "SUPERSEDED",
    "REVALIDATION_FAILED",
    "FAILED",
    "EXECUTION_UNKNOWN",
  ]),
  superseded_by: uuid.nullable(),
  decided_by: uuid.nullable(),
  decided_at: z.string().nullable(),
  created_at: z.string(),
  expires_at: z.string(),
});

type FilaPropuesta = z.infer<typeof filaPropuesta>;

/**
 * `ACCEPTED` es el estado en vuelo de la base (0053) y `ACCEPTING` el del
 * dominio (proposal.ts). Son el mismo estado con dos nombres: la traducción
 * vive acá, en el borde, y no en las dos puntas.
 */
function estadoDeDominio(status: FilaPropuesta["status"]): AssistantProposal["status"] {
  return status === "ACCEPTED" ? "ACCEPTING" : status;
}

function razonesIlegibles(fila: FilaPropuesta): Unknown[] {
  const n = fila.resumen.reasons.filter((r) => !esCodigoDeRazon(r.code)).length;
  if (n === 0) return [];
  return [
    {
      campo: "explicación",
      simbolo: "MISSING_DATA",
      motivo: `Hay ${n} motivo(s) de esta propuesta que esta versión no sabe redactar.`,
    },
  ];
}

function aPropuesta(fila: FilaPropuesta): PropuestaParaTarjeta {
  return {
    id: fila.id,
    householdId: fila.household_id,
    createdByMemberId: fila.created_by,
    accion: fila.accion,
    args: fila.args,
    // Las capacidades guardadas son las que evalúa la política de RLS; acá solo
    // se recupera la que la tarjeta necesita para saber de quién es el dato
    // clínico, porque el segundo gesto es tocar SU nombre.
    requires: fila.requires.flatMap((c) =>
      c.k === "MEDICAL" && typeof c.owner === "string" && esPermisoMedico(c.permission)
        ? [{ k: "MEDICAL" as const, owner: c.owner, permission: c.permission }]
        : [],
    ),
    resumen: {
      titulo: fila.resumen.titulo,
      lineas: fila.resumen.lineas.map((l) => ({
        etiqueta: untrusted(l.etiqueta),
        valor: l.valor,
      })),
      reasons: fila.resumen.reasons.flatMap((r) =>
        esCodigoDeRazon(r.code)
          ? [
              {
                code: r.code,
                params: Object.fromEntries(
                  Object.entries(r.params).map(([k, v]) => [
                    k,
                    typeof v === "number" ? v : untrusted(v),
                  ]),
                ),
              },
            ]
          : [],
      ),
      provenance: fila.resumen.provenance,
      unknowns: [
        ...fila.resumen.unknowns.map((u) => ({
          campo: u.campo,
          simbolo: esSimboloDesconocido(u.simbolo) ? u.simbolo : ("UNRESOLVED" as const),
          motivo: u.motivo,
        })),
        // Un motivo cuyo código este build no sabe redactar se cae de la lista
        // de razones, y una tarjeta con menos explicaciones de las que tenía es
        // una tarjeta que perdió información en silencio. Se cuenta y se dice.
        ...razonesIlegibles(fila),
      ],
      // Se lee y NO se usa para pintar: la línea de irreversibilidad sale del
      // mapa congelado de `presentacion.ts`. Viaja igual porque el tipo la
      // exige y porque compararlas es cómo se detecta una fila manipulada.
      irreversible: fila.resumen.irreversible,
    },
    status: estadoDeDominio(fila.status),
    expiresAt: fila.expires_at,
  };
}

export type LecturaPropuesta =
  | { ok: true; propuesta: PropuestaParaTarjeta }
  | { ok: false; fallo: "NO_ESTA" | "LECTURA_FALLIDA" };

export async function leerPropuesta(db: Db, id: string): Promise<LecturaPropuesta> {
  try {
    const { data, error } = await db
      .from("assistant_proposals")
      .select(
        "id, household_id, created_by, trace_id, accion, args, risk, effect, requires, " +
          "dedupe_key, basis, resumen, status, superseded_by, decided_by, decided_at, " +
          "created_at, expires_at",
      )
      .eq("id", id)
      .limit(1);
    if (error) throw new DataAccessError("propuesta del asistente", error);
    const fila = parseRows(filaPropuesta, data, "propuesta del asistente")[0];
    // "No existe" y "no la puedes ver" salen por la misma puerta: la política
    // de la 0053 ya filtró, y distinguirlas acá convertiría la pantalla en un
    // oráculo sobre las propuestas de otras casas.
    if (fila === undefined) return { ok: false, fallo: "NO_ESTA" };
    return { ok: true, propuesta: aPropuesta(fila) };
  } catch (e) {
    if (e instanceof DataShapeError || e instanceof DataAccessError) {
      return { ok: false, fallo: "LECTURA_FALLIDA" };
    }
    return { ok: false, fallo: "LECTURA_FALLIDA" };
  }
}

/**
 * El contexto que la tarjeta necesita del LOTE, cuando la propuesta habla de
 * uno: si la cantidad está pesada, si el ajuste es merma mayor y contra qué
 * número se compara el segundo gesto.
 *
 * Las tres respuestas salen de la misma lectura porque las tres hablan del
 * mismo lote y porque separarlas invitaba a que alguien pidiera una y se
 * olvidara de las otras dos.
 *
 * `is_approximate` existe desde la 0013 y el pronóstico ya lo respeta ("parte
 * del stock está registrado como aproximado"); la tarjeta de confirmación era
 * el único lugar donde el dato se perdía justo antes de mover materia. Si no se
 * puede averiguar, la respuesta es `DESCONOCIDA` —que la tarjeta trata con el
 * mismo cuidado que APROXIMADO—, nunca `MEDIDO`.
 */
export interface ContextoDeLote {
  readonly medicion: Medicion;
  readonly mermaMayor: boolean;
  readonly cantidadEsperada: CantidadEsperada | null;
}

const filaLote = z.object({
  is_approximate: z.boolean(),
  quantity: z.union([z.number(), z.string()]).transform((v) => Number(v)),
  unit: z.string(),
});

type FilaLote = z.infer<typeof filaLote>;

/**
 * Contra qué número se compara lo que la persona escribe.
 *
 * Ojo con lo que NO hace: no inventa una cantidad. Si no la encuentra devuelve
 * `null`, y la tarjeta que exige segundo gesto se queda en solo lectura. Una
 * cantidad adivinada acá sería una comparación que siempre calza, o sea ningún
 * segundo gesto.
 */
function cantidadDeLaPropuesta(
  propuesta: PropuestaParaTarjeta,
  lote: FilaLote | null,
): CantidadEsperada | null {
  const { gramos, quantity, unit } = propuesta.args;
  if (typeof gramos === "number") return { valor: gramos, unidad: "g" };
  if (typeof quantity === "number" && typeof unit === "string") {
    return { valor: quantity, unidad: unit };
  }
  // Botar un lote no lleva cantidad en los argumentos: se va entero, así que el
  // número que hay que transcribir es lo que queda en él.
  if (propuesta.accion === "discardLot" || propuesta.accion === "qrDiscardLot") {
    return lote === null ? null : { valor: lote.quantity, unidad: lote.unit };
  }
  return null;
}

export async function contextoDeLaPropuesta(
  db: Db,
  propuesta: PropuestaParaTarjeta,
): Promise<ContextoDeLote> {
  const lotId = propuesta.args.lotId;
  if (typeof lotId !== "string") {
    // No habla de un lote: no hay cifra de balanza que marcar ni merma que medir.
    return {
      medicion: "MEDIDO",
      mermaMayor: false,
      cantidadEsperada: cantidadDeLaPropuesta(propuesta, null),
    };
  }

  let lote: FilaLote | null = null;
  let sePudoLeer = true;
  try {
    const { data, error } = await db
      .from("inventory_lots")
      .select("is_approximate, quantity, unit")
      .eq("id", lotId)
      .limit(1);
    if (error) throw new DataAccessError("lote de la propuesta", error);
    lote = parseRows(filaLote, data, "lote de la propuesta")[0] ?? null;
    if (lote === null) sePudoLeer = false;
  } catch {
    // No es un catch vacío: decide que la medición quede DESCONOCIDA, que es la
    // rama cuidadosa. Tragarlo devolviendo MEDIDO habría presentado como hecho
    // duro una cifra que nadie pudo verificar.
    sePudoLeer = false;
  }

  const nueva = propuesta.args.quantity;
  const mermaMayor =
    lote !== null &&
    typeof nueva === "number" &&
    lote.quantity > 0 &&
    nueva < lote.quantity / 2;

  return {
    medicion: !sePudoLeer || lote === null ? "DESCONOCIDA" : lote.is_approximate ? "APROXIMADO" : "MEDIDO",
    mermaMayor,
    cantidadEsperada: cantidadDeLaPropuesta(propuesta, lote),
  };
}
