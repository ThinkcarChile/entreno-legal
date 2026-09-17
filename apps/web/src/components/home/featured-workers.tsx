import { ButtonLink, Section } from "@/components/ui";
import { WorkerCard } from "@/components/profile/worker-card";

import type { WorkerProfile } from "@/lib/domain/types";

export function FeaturedWorkers({ workers }: { workers: readonly WorkerProfile[] }) {
  if (workers.length === 0) return null;

  return (
    <Section
      eyebrow="Personas verificadas"
      title="Trabajadores destacados"
      description="Cada perfil muestra reputación, puntualidad y trabajos completados. Tú decides con quién trabajar."
      action={
        <ButtonLink href="/trabajadores" variant="outline" size="sm">
          Ver todos
        </ButtonLink>
      }
      className="bg-white"
    >
      <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {workers.map((worker) => (
          <li key={worker.userId} className="flex">
            <WorkerCard worker={worker} />
          </li>
        ))}
      </ul>
    </Section>
  );
}
