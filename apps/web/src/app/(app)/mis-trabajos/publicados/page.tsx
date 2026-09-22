import type { Metadata } from "next";

import { Briefcase } from "lucide-react";

import { BucketTabs } from "@/components/jobs/bucket-tabs";
import { ClientJobCard } from "@/components/jobs/my-job-card";
import { ButtonLink, EmptyState } from "@/components/ui";
import { requireOnboardedUser } from "@/lib/auth/session";
import { clientBuckets } from "@/lib/domain/buckets";
import { getData } from "@/lib/data";

export const metadata: Metadata = {
  title: "Trabajos que publiqué",
  robots: { index: false, follow: false },
};

export default async function MyPublishedJobsPage() {
  await requireOnboardedUser("/mis-trabajos/publicados");
  const jobs = await getData().jobs.listMinePublished();
  const buckets = clientBuckets(jobs);

  return (
    <div className="container-page py-8 sm:py-12">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-h2 text-ink-950 sm:text-h1">
            Trabajos que publiqué
          </h1>
          <p className="mt-2 text-ink-600">
            Revisa ofertas, elige a quién contratas y sigue el avance.
          </p>
        </div>
        <ButtonLink href="/publicar" size="sm">
          Publicar otro
        </ButtonLink>
      </header>

      <div className="mt-8">
        {jobs.length === 0 ? (
          <EmptyState
            icon={<Briefcase size={28} aria-hidden="true" />}
            title="Todavía no has publicado ningún trabajo"
            description="Publica lo que necesitas y recibe ofertas de personas verificadas de tu zona."
            action={<ButtonLink href="/publicar">Publicar un trabajo</ButtonLink>}
          />
        ) : (
          <BucketTabs
            buckets={buckets.map((bucket) => ({
              id: bucket.id,
              label: bucket.label,
              items: bucket.items.map((job) => <ClientJobCard key={job.id} job={job} />),
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
