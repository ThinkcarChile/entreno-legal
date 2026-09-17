import { UserRole, VerificationStatus } from "@/lib/domain/enums";
import { computeTrustIndex, computeWorkerLevel } from "@/lib/reputation";
import { publicDisplayName } from "@/lib/utils/format";
import { money } from "@/lib/utils/money";

import type {
  PublicProfile,
  ReputationSnapshot,
  TrustSignals,
  WorkerProfile,
} from "@/lib/domain/types";

/**
 * Personas de demostración.
 *
 * Los perfiles públicos solo contienen lo que el producto permite mostrar:
 * nombre, inicial del apellido, foto, verificaciones y reputación.
 */

const daysAgo = (days: number): string =>
  new Date(Date.now() - days * 86_400_000).toISOString();

interface PersonSeed {
  id: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  city: string;
  regionCode: string;
  memberSinceDays: number;
  roles: readonly UserRole[];
  bio?: string;
}

function toProfile(seed: PersonSeed): PublicProfile {
  return {
    id: seed.id,
    firstName: seed.firstName,
    lastNameInitial: seed.lastName.charAt(0).toUpperCase(),
    displayName: publicDisplayName(seed.firstName, seed.lastName),
    avatarUrl: seed.avatarUrl,
    bio: seed.bio ?? null,
    city: seed.city,
    regionCode: seed.regionCode,
    memberSince: daysAgo(seed.memberSinceDays),
    roles: seed.roles,
  };
}

const clientSeeds: readonly PersonSeed[] = [
  {
    id: "usr-client-1",
    firstName: "Valentina",
    lastName: "Rojas",
    avatarUrl: null,
    city: "Providencia",
    regionCode: "13",
    memberSinceDays: 420,
    roles: [UserRole.CLIENT],
  },
  {
    id: "usr-client-2",
    firstName: "Matías",
    lastName: "Contreras",
    avatarUrl: null,
    city: "Viña del Mar",
    regionCode: "05",
    memberSinceDays: 180,
    roles: [UserRole.CLIENT],
  },
  {
    id: "usr-client-3",
    firstName: "Francisca",
    lastName: "Muñoz",
    avatarUrl: null,
    city: "Concepción",
    regionCode: "08",
    memberSinceDays: 95,
    roles: [UserRole.CLIENT, UserRole.WORKER],
  },
  {
    id: "usr-client-4",
    firstName: "Ignacio",
    lastName: "Herrera",
    avatarUrl: null,
    city: "Antofagasta",
    regionCode: "02",
    memberSinceDays: 260,
    roles: [UserRole.CLIENT],
  },
  {
    id: "usr-client-5",
    firstName: "Camila",
    lastName: "Navarro",
    avatarUrl: null,
    city: "Las Condes",
    regionCode: "13",
    memberSinceDays: 40,
    roles: [UserRole.CLIENT],
  },
];

export const demoClients: readonly PublicProfile[] = clientSeeds.map(toProfile);

interface WorkerSeed extends PersonSeed {
  headline: string;
  baseHourly: number;
  verificationStatus: VerificationStatus;
  reputation: ReputationSnapshot;
  trust: TrustSignals;
  categories: readonly string[];
  serviceAreas: readonly { regionCode: string; communeCode: string | null; radiusKm: number | null }[];
  availabilityNote: string;
  acceptsOvernight: boolean;
  isAcceptingJobs: boolean;
}

const workerSeeds: readonly WorkerSeed[] = [
  {
    id: "usr-worker-1",
    firstName: "Camila",
    lastName: "Fernández",
    avatarUrl: null,
    city: "Santiago",
    regionCode: "13",
    memberSinceDays: 640,
    roles: [UserRole.WORKER],
    bio: "Hago filas de conciertos y lanzamientos desde 2024. Llego antes de la hora y mantengo informado al cliente con fotos cada hora.",
    headline: "Filas de conciertos y lanzamientos en el centro de Santiago",
    baseHourly: 10_000,
    verificationStatus: VerificationStatus.VERIFIED,
    reputation: {
      averageRating: 4.9,
      reviewCount: 118,
      completedJobs: 134,
      workedMinutes: 41_400,
      punctualityRate: 0.98,
      completionRate: 0.99,
      cancellationCount: 1,
      communicationRate: 0.97,
      accountAgeDays: 640,
      responseMinutesMedian: 6,
    },
    trust: { identityVerified: true, phoneVerified: true, bankAccountVerified: true, emailVerified: true },
    categories: ["cat-fila-conciertos", "cat-fila-lanzamientos", "cat-fila-overnight"],
    serviceAreas: [
      { regionCode: "13", communeCode: "13-santiago", radiusKm: 12 },
      { regionCode: "13", communeCode: "13-providencia", radiusKm: 10 },
    ],
    availabilityNote: "Disponible de lunes a domingo, incluidas madrugadas.",
    acceptsOvernight: true,
    isAcceptingJobs: true,
  },
  {
    id: "usr-worker-2",
    firstName: "Sebastián",
    lastName: "Álvarez",
    avatarUrl: null,
    city: "Ñuñoa",
    regionCode: "13",
    memberSinceDays: 300,
    roles: [UserRole.WORKER],
    bio: "Trámites y gestiones presenciales. Trabajo con checklist y entrego comprobante fotográfico de cada paso.",
    headline: "Trámites y gestiones presenciales permitidas",
    baseHourly: 12_500,
    verificationStatus: VerificationStatus.VERIFIED,
    reputation: {
      averageRating: 4.8,
      reviewCount: 46,
      completedJobs: 52,
      workedMinutes: 12_600,
      punctualityRate: 0.94,
      completionRate: 0.96,
      cancellationCount: 2,
      communicationRate: 0.95,
      accountAgeDays: 300,
      responseMinutesMedian: 11,
    },
    trust: { identityVerified: true, phoneVerified: true, bankAccountVerified: true, emailVerified: true },
    categories: ["cat-tramite-documentos", "cat-tramite-pedidos", "cat-tramite-espera"],
    serviceAreas: [{ regionCode: "13", communeCode: null, radiusKm: 25 }],
    availabilityNote: "Lunes a viernes de 08:00 a 18:00.",
    acceptsOvernight: false,
    isAcceptingJobs: true,
  },
  {
    id: "usr-worker-3",
    firstName: "Daniela",
    lastName: "Pizarro",
    avatarUrl: null,
    city: "Valparaíso",
    regionCode: "05",
    memberSinceDays: 150,
    roles: [UserRole.WORKER],
    bio: "Región de Valparaíso. Filas de eventos y retiro de pedidos. Respondo rápido y coordino relevos si el trabajo es largo.",
    headline: "Filas y encargos en Valparaíso y Viña del Mar",
    baseHourly: 8_500,
    verificationStatus: VerificationStatus.VERIFIED,
    reputation: {
      averageRating: 4.7,
      reviewCount: 22,
      completedJobs: 25,
      workedMinutes: 6_300,
      punctualityRate: 0.92,
      completionRate: 0.94,
      cancellationCount: 1,
      communicationRate: 0.93,
      accountAgeDays: 150,
      responseMinutesMedian: 14,
    },
    trust: { identityVerified: true, phoneVerified: true, bankAccountVerified: false, emailVerified: true },
    categories: ["cat-fila-conciertos", "cat-tramite-pedidos", "cat-fila-restaurantes"],
    serviceAreas: [
      { regionCode: "05", communeCode: "05-valparaiso", radiusKm: 15 },
      { regionCode: "05", communeCode: "05-vina-del-mar", radiusKm: 15 },
    ],
    availabilityNote: "Tardes y fines de semana.",
    acceptsOvernight: true,
    isAcceptingJobs: true,
  },
  {
    id: "usr-worker-4",
    firstName: "Rodrigo",
    lastName: "Salazar",
    avatarUrl: null,
    city: "Concepción",
    regionCode: "08",
    memberSinceDays: 75,
    roles: [UserRole.WORKER],
    bio: "Recién llegado a la plataforma, con experiencia previa en atención presencial.",
    headline: "Gestiones presenciales en el Gran Concepción",
    baseHourly: 9_000,
    verificationStatus: VerificationStatus.VERIFIED,
    reputation: {
      averageRating: 4.6,
      reviewCount: 7,
      completedJobs: 8,
      workedMinutes: 1_920,
      punctualityRate: 0.88,
      completionRate: 0.9,
      cancellationCount: 1,
      communicationRate: 0.9,
      accountAgeDays: 75,
      responseMinutesMedian: 22,
    },
    trust: { identityVerified: true, phoneVerified: true, bankAccountVerified: true, emailVerified: true },
    categories: ["cat-tramite-documentos", "cat-fila-instituciones"],
    serviceAreas: [{ regionCode: "08", communeCode: "08-concepcion", radiusKm: 20 }],
    availabilityNote: "Mañanas de lunes a viernes.",
    acceptsOvernight: false,
    isAcceptingJobs: true,
  },
  {
    id: "usr-worker-5",
    firstName: "Josefa",
    lastName: "Lagos",
    avatarUrl: null,
    city: "Antofagasta",
    regionCode: "02",
    memberSinceDays: 20,
    roles: [UserRole.WORKER],
    bio: "Nueva en HagoTuFila. Verificación de identidad en revisión.",
    headline: "Disponible para filas y encargos en Antofagasta",
    baseHourly: 9_500,
    verificationStatus: VerificationStatus.PENDING,
    reputation: {
      averageRating: 0,
      reviewCount: 0,
      completedJobs: 0,
      workedMinutes: 0,
      punctualityRate: 0,
      completionRate: 0,
      cancellationCount: 0,
      communicationRate: 0,
      accountAgeDays: 20,
      responseMinutesMedian: null,
    },
    trust: { identityVerified: false, phoneVerified: true, bankAccountVerified: false, emailVerified: true },
    categories: ["cat-fila-instituciones", "cat-tramite-otros"],
    serviceAreas: [{ regionCode: "02", communeCode: "02-antofagasta", radiusKm: 15 }],
    availabilityNote: "Disponible todo el día.",
    acceptsOvernight: true,
    isAcceptingJobs: false,
  },
  {
    id: "usr-worker-6",
    firstName: "Tomás",
    lastName: "Riquelme",
    avatarUrl: null,
    city: "Maipú",
    regionCode: "13",
    memberSinceDays: 500,
    roles: [UserRole.WORKER],
    bio: "Especialista en filas overnight. Llevo equipo propio y coordino turnos largos sin abandonar el lugar.",
    headline: "Filas overnight y de larga duración",
    baseHourly: 14_000,
    verificationStatus: VerificationStatus.VERIFIED,
    reputation: {
      averageRating: 4.9,
      reviewCount: 64,
      completedJobs: 71,
      workedMinutes: 34_200,
      punctualityRate: 0.97,
      completionRate: 0.98,
      cancellationCount: 1,
      communicationRate: 0.96,
      accountAgeDays: 500,
      responseMinutesMedian: 8,
    },
    trust: { identityVerified: true, phoneVerified: true, bankAccountVerified: true, emailVerified: true },
    categories: ["cat-fila-overnight", "cat-fila-conciertos", "cat-fila-lanzamientos"],
    serviceAreas: [{ regionCode: "13", communeCode: null, radiusKm: 30 }],
    availabilityNote: "Turnos nocturnos y fines de semana.",
    acceptsOvernight: true,
    isAcceptingJobs: true,
  },
];

function toWorker(seed: WorkerSeed): WorkerProfile {
  const trustIndex = computeTrustIndex({
    reputation: seed.reputation,
    trust: seed.trust,
    verificationStatus: seed.verificationStatus,
  }).value;

  // El nivel se deriva con la misma función desacoplada que usa producción.
  const level = computeWorkerLevel({
    reputation: seed.reputation,
    verificationStatus: seed.verificationStatus,
    trustIndex,
  });

  return {
    userId: seed.id,
    profile: toProfile(seed),
    headline: seed.headline,
    verificationStatus: seed.verificationStatus,
    level,
    trustIndex,
    baseHourlyRate: money(seed.baseHourly),
    categories: seed.categories,
    serviceAreas: seed.serviceAreas.map((area, index) => ({
      id: `${seed.id}-area-${index}`,
      workerId: seed.id,
      ...area,
    })),
    availabilityNote: seed.availabilityNote,
    acceptsOvernight: seed.acceptsOvernight,
    reputation: seed.reputation,
    trust: seed.trust,
    isAcceptingJobs: seed.isAcceptingJobs,
  };
}

export const demoWorkers: readonly WorkerProfile[] = workerSeeds.map(toWorker);

export function findDemoWorker(userId: string): WorkerProfile | undefined {
  return demoWorkers.find((w) => w.userId === userId);
}

export function findDemoClient(userId: string): PublicProfile | undefined {
  return demoClients.find((c) => c.id === userId);
}

export const demoProfiles: readonly PublicProfile[] = [
  ...demoClients,
  ...demoWorkers.map((w) => w.profile),
];
