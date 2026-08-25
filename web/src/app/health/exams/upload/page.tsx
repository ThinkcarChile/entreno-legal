import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppNav } from "@/components/AppNav";
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
  // Subir exige poder ADMINISTRAR: self o dependiente a cargo (o grant UPLOAD).
  const candidatos = miembros.filter((m) => m.relation !== "GRANTED");

  return (
    <main className="mx-auto max-w-md px-4 pb-16">
      <AppNav active="health" />
      <h1 className="mb-1 text-xl font-semibold">Subir examen</h1>
      <p className="mb-4 text-xs text-[var(--ink)]/60">
        El archivo queda en almacenamiento PRIVADO. La extracción por IA solo corre si la
        persona consiente; si no, el examen se revisa a mano — ambas rutas valen.
      </p>
      <UploadForm miembros={candidatos} />
    </main>
  );
}
