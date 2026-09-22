import { MapPin } from "lucide-react";

import { JobCard } from "@/components/jobs/job-card";
import { ButtonLink, EmptyState, Section } from "@/components/ui";

import type { JobSummary } from "@/lib/domain/types";

/**
 * Trabajos abiertos en la portada.
 *
 * Es la prueba de que esto es un mercado y no un folleto: si hay trabajos, se
 * ven; si no hay ninguno, se dice, y se invita a publicar el primero en vez de
 * rellenar la rejilla con ejemplos inventados.
 *
 * Las tarjetas muestran comuna y región, nunca la dirección exacta: esa solo
 * existe para el trabajador ya asignado (`listOpen` tampoco la trae).
 */
export function OpenJobs({ jobs }: { jobs: readonly JobSummary[] }) {
  return (
    <Section
      eyebrow="Disponible ahora"
      title="Trabajos publicados"
      description="Cada uno muestra comuna, fecha, duración y presupuesto. La dirección exacta se comparte solo con la persona asignada."
      action={
        jobs.length > 0 ? (
          <ButtonLink href="/trabajos" variant="outline" size="sm">
            Ver todos
          </ButtonLink>
        ) : undefined
      }
      className="bg-canvas-warm"
    >
      {jobs.length === 0 ? (
        <EmptyState
          icon={<MapPin size={22} aria-hidden="true" />}
          title="Todavía no hay trabajos abiertos"
          description="Cuando alguien publique una fila o un trámite, aparecerá aquí para toda la comunidad."
          action={<ButtonLink href="/publicar">Publicar un trabajo</ButtonLink>}
        />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {jobs.map((job) => (
            <li key={job.id} className="relative flex">
              <JobCard job={job} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
