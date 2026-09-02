import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppShell } from "@/components/AppShell";
import { Notice } from "@/components/ui";
import { UploadForm } from "./UploadForm";

export const dynamic = "force-dynamic";

/**
 * /finanzas/boletas/upload — la puerta de entrada de la boleta.
 *
 * Calcada de /health/exams/upload: bucket privado, consentimiento explícito y
 * móvil primero. La diferencia es a quién pertenece el dato: una boleta no es
 * dato clínico, así que no pasa por los grants médicos — pero sí por el permiso
 * financiero del hogar.
 */
export default async function SubirBoletaPage() {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/finanzas/boletas/upload");

  return (
    <AppShell
      active="shopping"
      title="Subir boleta"
      subtitle="El archivo queda en almacenamiento privado del hogar."
    >
      <div className="mt-md space-y-md">
        <Notice icon="savings" tono="atencion">
          Comprar no es gastar: lo que entra a la despensa sigue siendo tuyo, guardado. El gasto
          aparece cuando se come, se echa a perder o se pierde. Por eso una boleta confirmada deja
          <strong> valor</strong> en la despensa, no un gasto consumido.
        </Notice>
        <UploadForm />
      </div>
    </AppShell>
  );
}
