import type { Metadata } from "next";

import { ClipboardList } from "lucide-react";

import { BucketTabs } from "@/components/jobs/bucket-tabs";
import { WorkerJobCard } from "@/components/jobs/my-job-card";
import { ButtonLink, EmptyState } from "@/components/ui";
import { Alert } from "@/components/ui/feedback";
import { requireWorker } from "@/lib/auth/session";
import { workerBuckets } from "@/lib/domain/buckets";
import { canSendOffers } from "@/lib/domain/eligibility";
import { getData } from "@/lib/data";

export const metadata: Metadata = {
  title: "Mis trabajos",
  robots: { index: false, follow: false },
};

export default async function MyWorkerJobsPage() {
  const session = await requireWorker("/mis-trabajos");
  const jobs = await getData().jobs.listMineAsWorker();
  const buckets = workerBuckets(jobs);
  const eligibility = canSendOffers(session.worker);

  return (
    <div className="container-page py-8 sm:py-12">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink-900 sm:text-3xl">
            Mis trabajos
          </h1>
          <p className="mt-2 text-ink-600">Tus ofertas enviadas y los trabajos que tomaste.</p>
        </div>
        <ButtonLink href="/trabajos" size="sm" variant="outline">
          Buscar trabajos
        </ButtonLink>
      </header>

      {!eligibility.allowed && (
        <Alert tone="warning" className="mt-6" title="Completa tu verificación para comenzar a trabajar">
          {eligibility.message}
        </Alert>
      )}

      <div className="mt-8">
        {jobs.length === 0 ? (
          <EmptyState
            icon={<ClipboardList size={28} aria-hidden="true" />}
            title="Aún no has enviado ofertas"
            description="Explora los trabajos publicados en tu zona y propone tu tarifa. Tú decides cuánto cobrar."
            action={<ButtonLink href="/trabajos">Ver trabajos disponibles</ButtonLink>}
          />
        ) : (
          <BucketTabs
            buckets={buckets.map((bucket) => ({
              id: bucket.id,
              label: bucket.label,
              items: bucket.items.map((job) => <WorkerJobCard key={job.id} job={job} />),
              empty: (
                <EmptyState title={bucket.emptyTitle} description={bucket.emptyDescription} />
              ),
            }))}
          />
        )}
      </div>
    </div>
  );
}
