import { AssignmentStatus, JobStatus, OfferStatus } from "./enums";

import type { ClientJobSummary, WorkerJobSummary } from "./types";

/**
 * Agrupación de "mis trabajos".
 *
 * Vive aquí y no en las páginas para que cliente y trabajador vean siempre los
 * mismos criterios, y para poder cambiarlos en un solo lugar.
 */

export interface Bucket<T> {
  id: string;
  label: string;
  emptyTitle: string;
  emptyDescription: string;
  items: readonly T[];
}

export function clientBuckets(jobs: readonly ClientJobSummary[]): readonly Bucket<ClientJobSummary>[] {
  const waiting = jobs.filter((j) => j.status === JobStatus.PUBLISHED && j.offerCount === 0);
  const withOffers = jobs.filter((j) => j.status === JobStatus.PUBLISHED && j.offerCount > 0);
  const assigned = jobs.filter(
    (j) => j.status === JobStatus.OFFER_ACCEPTED || j.status === JobStatus.PAYMENT_PENDING,
  );
  const running = jobs.filter(
    (j) =>
      j.status === JobStatus.PAID ||
      j.status === JobStatus.IN_PROGRESS ||
      j.status === JobStatus.HANDOFF_COMPLETED,
  );
  const finished = jobs.filter(
    (j) => j.status === JobStatus.COMPLETED || j.status === JobStatus.CLOSED,
  );
  const cancelled = jobs.filter(
    (j) => j.status === JobStatus.CANCELLED || j.status === JobStatus.EXPIRED,
  );

  return [
    {
      id: "con-ofertas",
      label: "Con ofertas",
      emptyTitle: "Todavía no llegan ofertas",
      emptyDescription:
        "Cuando alguien oferte por uno de tus trabajos, aparecerá aquí para que compares.",
      items: withOffers,
    },
    {
      id: "esperando",
      label: "Esperando ofertas",
      emptyTitle: "Sin trabajos esperando",
      emptyDescription: "Publica un trabajo y empieza a recibir ofertas de personas verificadas.",
      items: waiting,
    },
    {
      id: "asignados",
      label: "Asignados",
      emptyTitle: "Ningún trabajo asignado",
      emptyDescription: "Cuando aceptes una oferta, el trabajo aparecerá aquí.",
      items: assigned,
    },
    {
      id: "en-curso",
      label: "En curso",
      emptyTitle: "Nada en curso",
      emptyDescription: "Aquí verás los trabajos pagados y en ejecución.",
      items: running,
    },
    {
      id: "terminados",
      label: "Terminados",
      emptyTitle: "Sin trabajos terminados",
      emptyDescription: "Los trabajos completados quedan aquí con su historial.",
      items: finished,
    },
    {
      id: "cancelados",
      label: "Cancelados",
      emptyTitle: "Sin cancelaciones",
      emptyDescription: "Los trabajos cancelados o vencidos aparecen aquí.",
      items: cancelled,
    },
  ];
}

export function workerBuckets(jobs: readonly WorkerJobSummary[]): readonly Bucket<WorkerJobSummary>[] {
  const offered = jobs.filter((j) => j.offerStatus === OfferStatus.PENDING && !j.assignmentId);
  const accepted = jobs.filter(
    (j) => j.assignmentStatus === AssignmentStatus.AWAITING_PAYMENT,
  );
  const upcoming = jobs.filter((j) => j.assignmentStatus === AssignmentStatus.CONFIRMED);
  const running = jobs.filter(
    (j) =>
      j.assignmentStatus === AssignmentStatus.ON_THE_WAY ||
      j.assignmentStatus === AssignmentStatus.CHECKED_IN ||
      j.assignmentStatus === AssignmentStatus.IN_PROGRESS ||
      j.assignmentStatus === AssignmentStatus.HANDOFF_COMPLETED,
  );
  const finished = jobs.filter(
    (j) =>
      j.assignmentStatus === AssignmentStatus.COMPLETED ||
      j.offerStatus === OfferStatus.REJECTED ||
      j.offerStatus === OfferStatus.WITHDRAWN ||
      j.offerStatus === OfferStatus.EXPIRED,
  );

  return [
    {
      id: "ofertados",
      label: "Ofertados",
      emptyTitle: "No tienes ofertas activas",
      emptyDescription: "Explora los trabajos disponibles y envía tu primera oferta.",
      items: offered,
    },
    {
      id: "aceptados",
      label: "Aceptados",
      emptyTitle: "Ninguna oferta aceptada todavía",
      emptyDescription:
        "Cuando un cliente te elija, el trabajo aparecerá aquí a la espera del pago.",
      items: accepted,
    },
    {
      id: "proximos",
      label: "Próximos",
      emptyTitle: "Sin trabajos confirmados",
      emptyDescription: "Los trabajos con pago confirmado y fecha por delante se ven aquí.",
      items: upcoming,
    },
    {
      id: "en-curso",
      label: "En curso",
      emptyTitle: "Nada en curso",
      emptyDescription: "Cuando comiences un trabajo lo verás aquí con su línea de tiempo.",
      items: running,
    },
    {
      id: "terminados",
      label: "Terminados",
      emptyTitle: "Sin historial todavía",
      emptyDescription: "Aquí quedan los trabajos completados y las ofertas que no prosperaron.",
      items: finished,
    },
  ];
}
