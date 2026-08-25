import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { loadHouseholdMembers } from "@/app/family/nutrition-queries";
import { DataAccessError } from "@/lib/supabase/unwrap";
import { z } from "zod";
import { parseRows, uuid } from "@/lib/supabase/rows";
import { QrActions } from "./QrActions";

export const dynamic = "force-dynamic";

const lotSchema = z.object({
  lot_id: z.string(),
  label: z.string(),
  quantity: z.union([z.number(), z.string().transform(Number)]),
  unit: z.enum(["G", "ML", "UNIT"]),
  status: z.string(),
  processing_state: z.string(),
  temperature_state: z.string(),
  package_code: z.string().nullable(),
  intended_use_date: z.string().nullable(),
  use_by: z.string().nullable(),
});

/**
 * /q/[token] (§36-§37): la puerta del QR. El token es OPACO; resolverlo exige
 * sesión y pertenencia al hogar — token desconocido y token ajeno responden
 * lo mismo. Nada del hogar viaja en la URL.
 */
export default async function QrPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/q/${encodeURIComponent(token)}`);

  const { householdId } = await loadHouseholdMembers(supabase);
  if (!householdId) redirect("/family");

  const { data, error } = await supabase.rpc("resolve_lot_token", { p_token: token });
  if (error) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-4xl">🔒</p>
        <h1 className="text-xl font-semibold">Etiqueta no disponible</h1>
        <p className="text-sm text-[var(--ink)]/60">
          Este código no corresponde a un paquete de tu hogar.
        </p>
      </main>
    );
  }
  const lot = lotSchema.parse(data);

  const { data: locData, error: locError } = await supabase
    .from("storage_locations")
    .select("id, name, kind")
    .eq("household_id", householdId)
    .order("sort_order");
  if (locError) throw new DataAccessError("ubicaciones", locError);
  const locations = parseRows(
    z.object({ id: uuid, name: z.string(), kind: z.enum(["PANTRY", "FRIDGE", "FREEZER", "OTHER"]) }),
    locData,
    "ubicaciones",
  );

  return <QrActions lot={lot} locations={locations} />;
}
