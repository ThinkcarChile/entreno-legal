import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppShell } from "@/components/AppShell";
import { Notice } from "@/components/ui";
import { loadAccessibleMembers } from "../../queries";
import { UploadForm } from "./UploadForm";

export const dynamic = "force-dynamic";

/**
 * /health/exams/upload (§53): subir examen → elegir integrante →
 * consentimiento → archivo. Móvil primero.
 */
export default async function UploadExamPage() {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/health/exams/upload");

  const miembros = await loadAccessibleMembers(supabase);
  // Subir exige poder ADMINISTRAR: self o dependiente a cargo.
  const candidatos = miembros.filter((m) => m.relation !== "GRANTED");

  return (
    <AppShell active="health" title="Subir examen" subtitle="El archivo queda en almacenamiento privado.">
      <div className="mt-md space-y-md">
        <Notice icon="shield_lock" tono="info">
          La extracción automática solo corre si la persona consiente. Sin consentimiento el
          examen se guarda igual y se revisa a mano: las dos rutas valen.
        </Notice>
        <UploadForm miembros={candidatos} />
      </div>
    </AppShell>
  );
}
