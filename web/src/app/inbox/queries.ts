import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { parseRows, uuid, DataShapeError } from "@/lib/supabase/rows";
import { DataAccessError } from "@/lib/supabase/unwrap";
import {
  esSimboloDesconocido,
  fraseDeRazonGuardada,
  saneaTexto,
} from "@/domain/assistant/presentacion";
import { INBOX_KINDS } from "./vista";
import type { ItemInbox, LecturaBandeja } from "./vista";

type Db = SupabaseClient;

/**
 * Lectura de la bandeja. Una sola llamada, a `inbox_abiertos` (0056), que es
 * `stable`: leer la bandeja NO escribe una fila. La caducidad la resuelve el
 * predicado del propio RPC y quien marca CADUCO es el cron, fuera del camino
 * de lectura — así "no pude verificar tu bandeja" queda reservado para cuando
 * de verdad falló la lectura, y no para cuando falló una escritura que la
 * lectura no necesitaba.
 *
 * Devuelve un resultado tipado en vez de lanzar: la pantalla tiene que poder
 * pintar un error de lectura con todas sus letras, y una excepción que sube
 * hasta el `error.tsx` global se ve igual que "la app se cayó".
 */

/** Tope de un título del inbox. Es una frase, no una etiqueta de una palabra. */
const TOPE_TITULO = 160;

const razonGuardada = z.object({
  code: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  // `text` puede venir en la fila (los motores guardan `Reason` completo) y se
  // IGNORA a propósito: es la frase ya compuesta con nombres que escribió
  // alguien de la casa. La frase se arma de nuevo acá, con los params limpios.
});

const desconocidoGuardado = z.object({
  campo: z.string(),
  simbolo: z.string(),
  motivo: z.string(),
});

const procedenciaGuardada = z.object({
  motor: z.string(),
  version: z.string(),
});

const filaInbox = z.object({
  id: uuid,
  kind: z.enum(INBOX_KINDS),
  severidad: z.number().int(),
  titulo: z.string(),
  detalle: z.array(razonGuardada).default([]),
  unknowns: z.array(desconocidoGuardado).default([]),
  provenance: z.array(procedenciaGuardada).default([]),
  ventana: z.string().nullable(),
  proposal_id: uuid.nullable(),
  ref_table: z.string().nullable(),
  ref_id: uuid.nullable(),
  created_at: z.string(),
});

function aItem(fila: z.infer<typeof filaInbox>): ItemInbox {
  return {
    id: fila.id,
    kind: fila.kind,
    severidad: fila.severidad,
    titulo: saneaTexto(fila.titulo, TOPE_TITULO),
    detalle: fila.detalle.map((r) => fraseDeRazonGuardada(r.code, r.params)),
    unknowns: fila.unknowns.map((u) => ({
      campo: saneaTexto(u.campo, 40),
      // Un símbolo que no está en el vocabulario cerrado NO se descarta: se
      // muestra como UNRESOLVED. Perderlo sería exactamente el "no sé" que se
      // vuelve silencio.
      simbolo: esSimboloDesconocido(u.simbolo) ? u.simbolo : "UNRESOLVED",
      motivo: saneaTexto(u.motivo, 200),
    })),
    procedencia: fila.provenance.map((p) => p.version),
    ventana: fila.ventana,
    proposalId: fila.proposal_id,
    ref:
      fila.ref_table !== null && fila.ref_id !== null
        ? { tabla: fila.ref_table, id: fila.ref_id }
        : null,
    createdAt: fila.created_at,
  };
}

export async function leerBandeja(db: Db, householdId: string): Promise<LecturaBandeja> {
  try {
    const { data, error } = await db.rpc("inbox_abiertos", { p_household: householdId });
    if (error) throw new DataAccessError("bandeja del hogar", error);
    return { ok: true, items: parseRows(filaInbox, data, "bandeja del hogar").map(aItem) };
  } catch (e) {
    // El `catch` no puede producir una lista vacía: eso es justo lo que hace
    // que un fallo se vea como calma. Distingue además los dos casos, porque
    // "la consulta falló" se reintenta y "la forma cambió" no.
    if (e instanceof DataShapeError) return { ok: false, fallo: "FORMA_INVALIDA" };
    if (e instanceof DataAccessError) return { ok: false, fallo: "LECTURA_FALLIDA" };
    return { ok: false, fallo: "LECTURA_FALLIDA" };
  }
}
