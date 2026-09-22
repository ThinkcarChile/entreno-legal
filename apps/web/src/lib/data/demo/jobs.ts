import { JobObjectiveType, JobStatus, JobUrgency, OfferStatus } from "@/lib/domain/enums";
import { communeName, regionName, timezoneFor } from "@/lib/geo/chile";
import { getPricingEngine } from "@/lib/pricing";
import { isOvernight, zonedInputToUtc } from "@/lib/utils/datetime";
import { money, proratePerHour } from "@/lib/utils/money";

import { findDemoCategory } from "./categories";
import { demoClients, demoWorkers } from "./people";

import type {
  Job,
  JobOffer,
  JobSummary,
  JobTimelineEntry,
  Review,
} from "@/lib/domain/types";

/**
 * Trabajos de demostración con montos realistas en pesos chilenos.
 *
 * Las fechas se calculan relativas al momento de la consulta para que la
 * demostración nunca muestre trabajos vencidos. Solo se consumen desde el servidor.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Fecha futura construida en hora local chilena, no en la del servidor.
 *
 * Sin esto, un contenedor en UTC generaría trabajos desplazados varias horas y
 * el motor de precios los tomaría por nocturnos cuando no lo son.
 */
function inDays(days: number, hour: number, minute = 0, timezone = "America/Santiago"): string {
  const day = new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  return zonedInputToUtc(day, time, timezone).toISOString();
}

function agoHours(hours: number): string {
  return new Date(Date.now() - hours * HOUR).toISOString();
}

interface JobSeed {
  id: string;
  reference: string;
  clientId: string;
  categoryId: string;
  status: JobStatus;
  title: string;
  description: string;
  instructions?: string;
  regionCode: string;
  communeCode: string;
  addressLine: string;
  placeName?: string;
  lat: number;
  lng: number;
  startsAt: string;
  durationMinutes: number;
  urgency: JobUrgency;
  objectiveType: JobObjectiveType;
  targetPosition?: number;
  objectiveDescription?: string;
  bonus?: number;
  bonusConditions?: string;
  hourlyRate: number;
  offerCount: number;
  viewCount: number;
  publishedHoursAgo: number;
}

const jobSeeds: readonly JobSeed[] = [
  {
    id: "job-1",
    reference: "HTF-2601",
    clientId: "usr-client-1",
    categoryId: "cat-fila-conciertos",
    status: JobStatus.PUBLISHED,
    title: "Fila para entradas de concierto en Costanera Center",
    description:
      "Necesito a alguien que haga la fila el sábado desde las 05:00 hasta aproximadamente las 10:00 en la boletería de Costanera Center. La venta abre a las 10:00 y yo llego a las 09:30 para tomar el lugar. Busco a alguien puntual, que avise cuando llegue y que mande una foto cada cierto tiempo para saber cómo avanza.",
    instructions:
      "Acceso por Av. Andrés Bello. La fila se forma frente a la entrada norte. Avísame apenas llegues y mándame una foto de la cantidad de gente que hay delante.",
    regionCode: "13",
    communeCode: "13-providencia",
    addressLine: "Av. Andrés Bello 2447, Costanera Center",
    placeName: "Costanera Center",
    lat: -33.4173,
    lng: -70.6065,
    startsAt: inDays(3, 5, 0),
    durationMinutes: 300,
    urgency: JobUrgency.NORMAL,
    objectiveType: JobObjectiveType.WITHIN_FIRST_N,
    targetPosition: 10,
    bonus: 15_000,
    bonusConditions: "Se paga si al momento de la entrega quedaste entre los primeros 10 de la fila.",
    hourlyRate: 10_000,
    offerCount: 4,
    viewCount: 142,
    publishedHoursAgo: 6,
  },
  {
    id: "job-2",
    reference: "HTF-2602",
    clientId: "usr-client-5",
    categoryId: "cat-fila-overnight",
    status: JobStatus.PUBLISHED,
    title: "Fila overnight por lanzamiento de consola en Parque Arauco",
    description:
      "Lanzamiento con stock limitado. Necesito que alguien tome el lugar desde las 22:00 del viernes hasta las 10:00 del sábado. Son 12 horas continuas, así que busco a alguien con experiencia en filas nocturnas y que venga preparado para el frío.",
    instructions:
      "Entrada de Boulevard, frente a la tienda. Llevar silla plegable y abrigo. Mantener el lugar sin abandonarlo.",
    regionCode: "13",
    communeCode: "13-las-condes",
    addressLine: "Av. Presidente Kennedy 5413, Parque Arauco",
    placeName: "Parque Arauco",
    lat: -33.4008,
    lng: -70.5776,
    startsAt: inDays(5, 22, 0),
    durationMinutes: 720,
    urgency: JobUrgency.NORMAL,
    objectiveType: JobObjectiveType.AS_FRONT_AS_POSSIBLE,
    bonus: 25_000,
    bonusConditions: "Se paga si quedas entre los primeros 20 al momento de la apertura.",
    hourlyRate: 14_000,
    offerCount: 6,
    viewCount: 310,
    publishedHoursAgo: 20,
  },
  {
    id: "job-3",
    reference: "HTF-2603",
    clientId: "usr-client-2",
    categoryId: "cat-tramite-pedidos",
    status: JobStatus.PUBLISHED,
    title: "Retirar pedido en tienda de Viña del Mar",
    description:
      "Tengo un pedido listo para retiro y no alcanzo a llegar antes del cierre. Es una caja mediana, alrededor de 6 kilos. Necesito que lo retiren y lo dejen en mi edificio en el centro de Viña.",
    instructions:
      "El retiro está a mi nombre y la tienda permite retiro por terceros con el código de la orden. Te envío el código por el chat una vez que acordemos.",
    regionCode: "05",
    communeCode: "05-vina-del-mar",
    addressLine: "Av. Libertad 1348, Viña del Mar",
    lat: -33.0245,
    lng: -71.5518,
    startsAt: inDays(1, 16, 30),
    durationMinutes: 90,
    urgency: JobUrgency.URGENTE,
    objectiveType: JobObjectiveType.COMPLETE_ERRAND,
    objectiveDescription: "Retirar el pedido y entregarlo en conserjería.",
    hourlyRate: 12_000,
    offerCount: 3,
    viewCount: 68,
    publishedHoursAgo: 2,
  },
  {
    id: "job-4",
    reference: "HTF-2604",
    clientId: "usr-client-3",
    categoryId: "cat-fila-instituciones",
    status: JobStatus.PUBLISHED,
    title: "Fila de atención presencial en oficina de Concepción",
    description:
      "Necesito que alguien tome número y espere el turno en la oficina de atención. Cuando falten pocos turnos me avisa y yo llego para ser atendida personalmente, porque el trámite requiere mi presencia.",
    instructions:
      "Importante: el trámite lo hago yo. Solo necesito que alguien espere el turno y me avise con anticipación.",
    regionCode: "08",
    communeCode: "08-concepcion",
    addressLine: "O'Higgins 420, Concepción",
    lat: -36.8269,
    lng: -73.0498,
    startsAt: inDays(2, 8, 0),
    durationMinutes: 180,
    urgency: JobUrgency.NORMAL,
    objectiveType: JobObjectiveType.HOLD_PLACE,
    hourlyRate: 9_000,
    offerCount: 2,
    viewCount: 54,
    publishedHoursAgo: 11,
  },
  {
    id: "job-5",
    reference: "HTF-2605",
    clientId: "usr-client-4",
    categoryId: "cat-tramite-espera",
    status: JobStatus.PUBLISHED,
    title: "Esperar al técnico de internet en departamento en Antofagasta",
    description:
      "La visita técnica está agendada entre las 09:00 y las 13:00 y no puedo faltar al trabajo. Necesito que alguien espere en el departamento, reciba al técnico y me mantenga informado por el chat.",
    instructions:
      "Dejo la llave con el conserje a nombre de la persona que acepte. No hay que firmar nada a mi nombre: si piden firma del titular, me llaman.",
    regionCode: "02",
    communeCode: "02-antofagasta",
    addressLine: "Av. Grecia 1250, Antofagasta",
    lat: -23.6509,
    lng: -70.3975,
    startsAt: inDays(4, 9, 0),
    durationMinutes: 240,
    urgency: JobUrgency.FLEXIBLE,
    objectiveType: JobObjectiveType.COMPLETE_ERRAND,
    objectiveDescription: "Recibir al técnico y acompañar la visita.",
    hourlyRate: 9_500,
    offerCount: 1,
    viewCount: 33,
    publishedHoursAgo: 30,
  },
  {
    id: "job-6",
    reference: "HTF-2606",
    clientId: "usr-client-1",
    categoryId: "cat-fila-restaurantes",
    status: JobStatus.PUBLISHED,
    title: "Fila de restaurante sin reserva en Barrio Italia",
    description:
      "El local no toma reservas y la fila empieza temprano. Necesito que alguien tome lugar desde las 12:00 y me avise cuando falten cerca de 15 minutos para entrar. Somos cuatro personas.",
    regionCode: "13",
    communeCode: "13-providencia",
    addressLine: "Av. Italia 1456, Providencia",
    lat: -33.4405,
    lng: -70.6244,
    startsAt: inDays(6, 12, 0),
    durationMinutes: 120,
    urgency: JobUrgency.FLEXIBLE,
    objectiveType: JobObjectiveType.HOLD_PLACE,
    hourlyRate: 8_500,
    offerCount: 5,
    viewCount: 97,
    publishedHoursAgo: 48,
  },
  {
    id: "job-7",
    reference: "HTF-2607",
    clientId: "usr-client-5",
    categoryId: "cat-tramite-documentos",
    status: JobStatus.IN_PROGRESS,
    title: "Entregar documentos en oficina de Las Condes",
    description:
      "Entrega de una carpeta con documentos en recepción. Requiere comprobante de recepción timbrado.",
    regionCode: "13",
    communeCode: "13-las-condes",
    addressLine: "Av. Apoquindo 3000, Las Condes",
    lat: -33.4172,
    lng: -70.6,
    startsAt: agoHours(2),
    durationMinutes: 120,
    urgency: JobUrgency.NORMAL,
    objectiveType: JobObjectiveType.COMPLETE_ERRAND,
    objectiveDescription: "Entregar la carpeta y traer el comprobante timbrado.",
    hourlyRate: 12_000,
    offerCount: 3,
    viewCount: 61,
    publishedHoursAgo: 72,
  },
];

function buildJob(seed: JobSeed): Job {
  const category = findDemoCategory(seed.categoryId);
  if (!category) throw new Error(`Categoría de demostración inexistente: ${seed.categoryId}`);

  const client = demoClients.find((c) => c.id === seed.clientId);
  if (!client) throw new Error(`Cliente de demostración inexistente: ${seed.clientId}`);

  const timezone = timezoneFor(seed.regionCode, seed.communeCode);
  const suggestion = getPricingEngine().suggest({
    categoryGroup: category.group,
    categoryId: category.id,
    categoryBase: {
      min: category.baseHourlyMin.amount,
      max: category.baseHourlyMax.amount,
    },
    regionCode: seed.regionCode,
    communeCode: seed.communeCode,
    startsAt: seed.startsAt,
    durationMinutes: seed.durationMinutes,
    urgency: seed.urgency,
    timezone,
  });

  const hourly = money(seed.hourlyRate);

  return {
    id: seed.id,
    reference: seed.reference,
    clientId: seed.clientId,
    client,
    category,
    status: seed.status,
    title: seed.title,
    description: seed.description,
    instructions: seed.instructions ?? null,
    location: {
      countryCode: "CL",
      regionCode: seed.regionCode,
      regionName: regionName(seed.regionCode),
      communeCode: seed.communeCode,
      communeName: communeName(seed.communeCode),
      placeName: seed.placeName ?? null,
      approxLat: Math.round(seed.lat * 100) / 100,
      approxLng: Math.round(seed.lng * 100) / 100,
      // En demostración nadie tiene sesión, así que nadie ve la dirección
      // exacta. Es exactamente lo que verá un visitante en producción.
      exact: null,
    },
    timezone,
    startsAt: seed.startsAt,
    estimatedDurationMinutes: seed.durationMinutes,
    isOvernight: isOvernight(seed.startsAt, seed.durationMinutes, timezone),
    urgency: seed.urgency,
    objective: {
      type: seed.objectiveType,
      targetPosition: seed.targetPosition ?? null,
      description: seed.objectiveDescription ?? null,
      bonus: seed.bonus ? money(seed.bonus) : null,
      bonusConditions: seed.bonusConditions ?? null,
    },
    proposedHourlyRate: hourly,
    proposedTotal: proratePerHour(hourly, seed.durationMinutes),
    suggestedHourlyMin: suggestion.hourlyMin,
    suggestedHourlyMax: suggestion.hourlyMax,
    images: [],
    offerCount: seed.offerCount,
    viewCount: seed.viewCount,
    publishedAt: agoHours(seed.publishedHoursAgo),
    expiresAt: seed.startsAt,
    createdAt: agoHours(seed.publishedHoursAgo + 1),
    updatedAt: agoHours(seed.publishedHoursAgo),
  };
}

export function demoJobs(): readonly Job[] {
  return jobSeeds.map(buildJob);
}

export function toSummary(job: Job): JobSummary {
  return {
    id: job.id,
    reference: job.reference,
    title: job.title,
    status: job.status,
    categoryName: job.category.name,
    categoryGroup: job.category.group,
    communeName: job.location.communeName,
    regionName: job.location.regionName,
    startsAt: job.startsAt,
    timezone: job.timezone,
    estimatedDurationMinutes: job.estimatedDurationMinutes,
    isOvernight: job.isOvernight,
    urgency: job.urgency,
    proposedHourlyRate: job.proposedHourlyRate,
    proposedTotal: job.proposedTotal,
    bonus: job.objective.bonus,
    offerCount: job.offerCount,
    clientDisplayName: job.client.displayName,
    clientAvatarUrl: job.client.avatarUrl,
    publishedAt: job.publishedAt,
  };
}

interface OfferSeed {
  jobId: string;
  workerId: string;
  hourlyRate: number;
  message: string;
  arrivalMinutesBefore: number;
  createdHoursAgo: number;
  status?: OfferStatus;
}

const offerSeeds: readonly OfferSeed[] = [
  {
    jobId: "job-1",
    workerId: "usr-worker-1",
    hourlyRate: 8_500,
    message:
      "Hola Valentina. Vivo a diez minutos de Costanera y hago filas de conciertos todas las semanas. Llego 04:40 para asegurar buen lugar y te mando foto cada hora.",
    arrivalMinutesBefore: 20,
    createdHoursAgo: 5,
  },
  {
    jobId: "job-1",
    workerId: "usr-worker-6",
    hourlyRate: 12_500,
    message:
      "Tengo experiencia en filas de venta de entradas con alta demanda. Llevo silla y cargador, y no me muevo del lugar hasta que llegues.",
    arrivalMinutesBefore: 45,
    createdHoursAgo: 4,
  },
  {
    jobId: "job-1",
    workerId: "usr-worker-3",
    hourlyRate: 10_000,
    message: "Disponible ese sábado. Puedo llegar desde las 04:30 si prefieres asegurar el lugar.",
    arrivalMinutesBefore: 30,
    createdHoursAgo: 3,
  },
  {
    jobId: "job-2",
    workerId: "usr-worker-6",
    hourlyRate: 14_000,
    message:
      "Hago filas overnight seguido. Llevo carpa pequeña si está permitido, abrigo y batería externa. Te aviso el estado cada dos horas.",
    arrivalMinutesBefore: 30,
    createdHoursAgo: 18,
  },
  {
    jobId: "job-2",
    workerId: "usr-worker-1",
    hourlyRate: 13_000,
    message: "Disponible para las 12 horas completas. Ya he hecho lanzamientos en Parque Arauco.",
    arrivalMinutesBefore: 20,
    createdHoursAgo: 15,
  },
  {
    jobId: "job-3",
    workerId: "usr-worker-3",
    hourlyRate: 9_500,
    message:
      "Estoy en Viña y puedo pasar hoy mismo antes del cierre. Te envío foto del pedido al retirarlo y al entregarlo en conserjería.",
    arrivalMinutesBefore: 15,
    createdHoursAgo: 1,
  },
  {
    jobId: "job-4",
    workerId: "usr-worker-4",
    hourlyRate: 9_000,
    message:
      "Puedo llegar antes de que abran para tomar número temprano. Te aviso apenas queden cinco turnos.",
    arrivalMinutesBefore: 30,
    createdHoursAgo: 9,
  },
  {
    jobId: "job-5",
    workerId: "usr-worker-5",
    hourlyRate: 9_500,
    message: "Disponible toda la mañana. Aviso apenas llegue el técnico.",
    arrivalMinutesBefore: 20,
    createdHoursAgo: 25,
  },
  {
    jobId: "job-6",
    workerId: "usr-worker-1",
    hourlyRate: 9_000,
    message: "Conozco el local, la fila se forma sobre Av. Italia. Te aviso cuando falten 15 minutos.",
    arrivalMinutesBefore: 15,
    createdHoursAgo: 40,
  },
  {
    jobId: "job-7",
    workerId: "usr-worker-2",
    hourlyRate: 12_000,
    message: "Puedo hacer la entrega y traer el comprobante timbrado.",
    arrivalMinutesBefore: 20,
    createdHoursAgo: 70,
    status: OfferStatus.ACCEPTED,
  },
];

export function demoOffers(jobId: string): readonly JobOffer[] {
  const jobs = demoJobs();
  return offerSeeds
    .filter((seed) => seed.jobId === jobId)
    .map((seed, index) => {
      const worker = demoWorkers.find((w) => w.userId === seed.workerId);
      const job = jobs.find((j) => j.id === seed.jobId);
      if (!worker || !job) throw new Error(`Oferta de demostración inconsistente: ${seed.jobId}`);

      const hourly = money(seed.hourlyRate);
      return {
        id: `${seed.jobId}-offer-${index + 1}`,
        jobId: seed.jobId,
        workerId: seed.workerId,
        worker,
        status: seed.status ?? OfferStatus.PENDING,
        hourlyRate: hourly,
        estimatedTotal: proratePerHour(hourly, job.estimatedDurationMinutes),
        message: seed.message,
        estimatedArrivalAt: new Date(
          new Date(job.startsAt).getTime() - seed.arrivalMinutesBefore * 60_000,
        ).toISOString(),
        createdAt: agoHours(seed.createdHoursAgo),
        respondedAt: seed.status === OfferStatus.ACCEPTED ? agoHours(seed.createdHoursAgo - 1) : null,
      } satisfies JobOffer;
    });
}

/** Timeline de demostración para el trabajo en curso. */
export function demoTimeline(jobId: string): readonly JobTimelineEntry[] {
  if (jobId !== "job-7") return [];
  const base = [
    { minutes: -122, type: "SYSTEM", title: "Pago confirmado", body: "El pago quedó protegido y asociado a este trabajo." },
    { minutes: -118, type: "LOCATION", title: "En camino", body: "Sebastián se dirige al lugar." },
    { minutes: -102, type: "CHECK_IN", title: "Check-in realizado", body: "Llegó a Av. Apoquindo 3000." },
    { minutes: -60, type: "NOTE", title: "Actualización", body: "Esperando en recepción, hay dos personas antes." },
    { minutes: -20, type: "QUEUE_STATUS", title: "2 personas delante", body: null },
  ] as const;

  return base.map((entry, index) => ({
    id: `${jobId}-timeline-${index + 1}`,
    assignmentId: `${jobId}-assignment`,
    jobId,
    authorId: index === 0 ? null : "usr-worker-2",
    authorName: index === 0 ? "HagoTuFila" : "Sebastián Á.",
    type: entry.type,
    title: entry.title,
    body: entry.body,
    imageUrl: null,
    storagePath: null,
    mimeType: null,
    sizeBytes: null,
    eventKey: null,
    queueAhead: entry.type === "QUEUE_STATUS" ? 2 : null,
    occurredAt: new Date(Date.now() + entry.minutes * 60_000).toISOString(),
    createdAt: new Date(Date.now() + entry.minutes * 60_000).toISOString(),
  }));
}

interface ReviewSeed {
  workerId: string;
  authorName: string;
  punctuality: number;
  communication: number;
  compliance: number;
  overall: number;
  comment: string;
  daysAgo: number;
}

const reviewSeeds: readonly ReviewSeed[] = [
  {
    workerId: "usr-worker-1",
    authorName: "Valentina R.",
    punctuality: 5,
    communication: 5,
    compliance: 5,
    overall: 5,
    comment:
      "Llegó antes de la hora acordada y me fue avisando cómo avanzaba la fila con fotos. Quedé segunda en la fila. Impecable.",
    daysAgo: 6,
  },
  {
    workerId: "usr-worker-1",
    authorName: "Matías C.",
    punctuality: 5,
    communication: 5,
    compliance: 4,
    overall: 5,
    comment: "Muy buena comunicación durante toda la espera. Repetiría sin dudarlo.",
    daysAgo: 19,
  },
  {
    workerId: "usr-worker-2",
    authorName: "Camila N.",
    punctuality: 5,
    communication: 4,
    compliance: 5,
    overall: 5,
    comment: "Entregó los documentos y me mandó el comprobante timbrado el mismo día.",
    daysAgo: 9,
  },
  {
    workerId: "usr-worker-3",
    authorName: "Francisca M.",
    punctuality: 4,
    communication: 5,
    compliance: 5,
    overall: 5,
    comment: "Retiró el pedido rápido y lo dejó en conserjería como acordamos.",
    daysAgo: 14,
  },
  {
    workerId: "usr-worker-6",
    authorName: "Ignacio H.",
    punctuality: 5,
    communication: 5,
    compliance: 5,
    overall: 5,
    comment:
      "Doce horas de fila nocturna sin moverse del lugar. Me mantuvo informado toda la noche. Vale cada peso.",
    daysAgo: 4,
  },
];

export function demoReviews(workerId: string, limit = 10): readonly Review[] {
  return reviewSeeds
    .filter((r) => r.workerId === workerId)
    .slice(0, limit)
    .map((seed, index) => ({
      id: `${workerId}-review-${index + 1}`,
      assignmentId: `${workerId}-assignment-${index + 1}`,
      authorId: `usr-client-${index + 1}`,
      authorName: seed.authorName,
      authorAvatarUrl: null,
      subjectId: workerId,
      punctuality: seed.punctuality,
      communication: seed.communication,
      compliance: seed.compliance,
      overall: seed.overall,
      comment: seed.comment,
      createdAt: new Date(Date.now() - seed.daysAgo * DAY).toISOString(),
    }));
}

/** Reseñas destacadas para la portada. */
export function demoFeaturedReviews(limit = 3): readonly Review[] {
  return reviewSeeds.slice(0, limit).map((seed, index) => ({
    id: `featured-review-${index + 1}`,
    assignmentId: `featured-assignment-${index + 1}`,
    authorId: `usr-client-${index + 1}`,
    authorName: seed.authorName,
    authorAvatarUrl: null,
    subjectId: seed.workerId,
    punctuality: seed.punctuality,
    communication: seed.communication,
    compliance: seed.compliance,
    overall: seed.overall,
    comment: seed.comment,
    createdAt: new Date(Date.now() - seed.daysAgo * DAY).toISOString(),
  }));
}
