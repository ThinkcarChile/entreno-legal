import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ChevronLeft } from "lucide-react";

import { EditJobForm } from "@/components/jobs/edit-job-form";
import { Card, CardContent } from "@/components/ui";
import { requireOnboardedUser } from "@/lib/auth/session";
import { getData } from "@/lib/data";
import { jobPermissions } from "@/lib/domain/job-actions";

export const metadata: Metadata = {
  title: "Editar trabajo",
  robots: { index: false, follow: false },
};

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function EditJobPage({ params }: PageProps) {
  const { id } = await params;
  const session = await requireOnboardedUser(`/mis-trabajos/publicados/${id}/editar`);

  const job = await getData().jobs.getById(id);
  if (!job) notFound();
  if (job.clientId !== session.id) redirect(`/trabajos/${id}`);

  // Con oferta aceptada la edición ya no corresponde.
  if (!jobPermissions(job.status, "client").canEdit) {
    redirect(`/mis-trabajos/publicados/${id}`);
  }

  return (
    <div className="container-page max-w-2xl py-6 sm:py-10">
      <Link
        href={`/mis-trabajos/publicados/${id}`}
        className="inline-flex items-center gap-1.5 text-small font-medium text-ink-600 hover:text-brand-700"
      >
        <ChevronLeft size={16} aria-hidden="true" />
        Volver al trabajo
      </Link>

      <h1 className="mt-6 text-h2 text-ink-950 sm:text-h1">
        Editar trabajo
      </h1>
      <p className="mt-2 text-ink-600">
        Puedes ajustar los datos mientras el trabajo siga recibiendo ofertas.
      </p>

      <Card className="mt-6">
        <CardContent className="sm:p-8">
          <EditJobForm job={job} />
        </CardContent>
      </Card>
    </div>
  );
}
