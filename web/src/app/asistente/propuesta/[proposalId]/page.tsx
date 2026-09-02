import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { ActionCard } from "@/components/assistant/ActionCard";
import { EmptyState, ErrorNote, Notice } from "@/components/ui";
import { loadHouseholdMembers } from "@/app/family/nutrition-queries";
import { createSupabaseServer } from "@/lib/supabase/server";
import { armarTarjeta } from "@/domain/assistant/presentacion";
import {
  generarConfirmationToken,
  hashConfirmationToken,
} from "@/domain/assistant/proposal";
import { confirmarPropuesta } from "../acciones";
import { contextoDeLaPropuesta, leerPropuesta } from "../queries";

export const dynamic = "force-dynamic";

/**
 * La tarjeta de confirmación, en su propia pantalla.
 *
 * Vive acá y no dentro de la lista porque el token de un solo uso se emite AL
 * RENDERIZAR la tarjeta, para ese actor: emitir uno por cada aviso cada vez que
 * alguien abre la bandeja sería fabricar confirmaciones que nadie miró. Acá se
 * emite uno, para la tarjeta que la persona está mirando de verdad.
 *
 * Si el token no se pudo emitir, la tarjeta se muestra igual pero SIN botón. Un
 * botón que va a fallar es peor que no tenerlo.
 */
export default async function PropuestaPage({
  params,
}: {
  params: Promise<{ proposalId: string }>;
}) {
  const { proposalId } = await params;

  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/asistente/propuesta/${proposalId}`);

  const { householdId, members } = await loadHouseholdMembers(supabase);
  if (!householdId) {
    return (
      <AppShell active="assistant" title="Propuesta">
        <div className="mt-md">
          <EmptyState icon="group_add">
            Primero crea o únete a un hogar en la pestaña Familia.
          </EmptyState>
        </div>
      </AppShell>
    );
  }

  const lectura = await leerPropuesta(supabase, proposalId);
  if (!lectura.ok) {
    return (
      <AppShell active="assistant" title="Propuesta">
        <div className="mt-md">
          {lectura.fallo === "NO_ESTA" ? (
            <EmptyState icon="search_off">
              No encuentro esa propuesta. Puede que ya se haya resuelto o que no te
              corresponda verla.
            </EmptyState>
          ) : (
            <ErrorNote>
              No pude leer la propuesta. Esto no dice nada sobre si sigue en pie:
              dice que no pude verificarla.
            </ErrorNote>
          )}
        </div>
      </AppShell>
    );
  }

  const propuesta = lectura.propuesta;
  const contexto = await contextoDeLaPropuesta(supabase, propuesta);

  const yo = members.find((m) => m.isMe);
  if (yo === undefined) {
    return (
      <AppShell active="assistant" title="Propuesta">
        <div className="mt-md">
          <ErrorNote>
            No pude identificarte dentro de este hogar, así que no puedo poner tu
            nombre en la confirmación. Sin eso, no hay a quién anotar en la
            auditoría.
          </ErrorNote>
        </div>
      </AppShell>
    );
  }

  // El token se emite acá, del lado del servidor, DESPUÉS de que cualquier
  // modelo terminó su trabajo. Por eso el modelo no puede fabricarlo y por eso
  // "el usuario ya autorizó" escrito adentro de una boleta no llega a nada.
  //
  // El SECRETO nace acá y la base solo recibe su hash, calculado por la misma
  // función que va a recalcularlo al confirmar. Antes lo generaba el RPC con su
  // propia receta (md5 del secreto pelado) y el dominio comparaba otra
  // (sha256 atado a la propuesta y al integrante): dos formatos que no calzaban,
  // o sea una compuerta que no se podía cerrar de punta a punta.
  let token: string | null = null;
  const secreto = generarConfirmationToken();
  const { error: tokenError } = await supabase.rpc("register_proposal_token", {
    p_id: proposalId,
    p_token_hash: hashConfirmationToken(secreto, proposalId, yo.id),
    p_expires_at: propuesta.expiresAt,
  });
  if (!tokenError) token = secreto;

  const nombres: Record<string, string> = {};
  for (const m of members) nombres[m.id] = m.displayName;

  const resultado = armarTarjeta(propuesta, {
    medicion: contexto.medicion,
    mermaMayor: contexto.mermaMayor,
    cantidadEsperada: contexto.cantidadEsperada,
    quienConfirma: { id: yo.id, nombre: yo.displayName },
    // Quien propuso puede haberse ido de la casa: ahí el nombre no existe y se
    // dice así. No es un respaldo que tape una lectura fallida — si la lista de
    // integrantes no se hubiera podido leer, la rama de arriba ya habría
    // cortado por no poder identificar a quien confirma.
    quienPropuso: nombres[propuesta.createdByMemberId] ?? "un integrante que ya no está",
    integrantes: nombres,
    token,
    // Instante, no día civil: lo que se compara es el vencimiento del token y
    // de la propuesta, que se miden en tiempo real y no en el calendario del
    // hogar.
    ahora: new Date().toISOString(),
  });

  return (
    <AppShell active="assistant" title="Confirmar" subtitle="Lo decides tú, no el chat">
      <div className="mt-md space-y-md">
        <ActionCard
          resultado={resultado}
          acceptedByMemberId={yo.id}
          integrantes={members.map((m) => ({ id: m.id, nombre: m.displayName }))}
          confirmar={confirmarPropuesta}
        />
        <Notice icon="info">
          El asistente no ejecuta nada por su cuenta: esta tarjeta es el gesto que
          autoriza, y vale una sola vez.
        </Notice>
      </div>
    </AppShell>
  );
}
