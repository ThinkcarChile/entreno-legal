import { communeName, regionName, timezoneFor } from "@/lib/geo/chile";
import { isOvernight } from "@/lib/utils/datetime";
import { publicDisplayName } from "@/lib/utils/format";
import { money, proratePerHour } from "@/lib/utils/money";

import type {
  AssignmentStatus,
  CategoryGroup,
  JobObjectiveType,
  JobStatus,
  JobUrgency,
  MessageType,
  NotificationType,
  OfferStatus,
  PaymentPurpose,
  PaymentStatus,
  UserRole,
  VerificationStatus,
  WorkerLevel,
} from "@/lib/domain/enums";
import type {
  AppNotification,
  Assignment,
  Job,
  JobCategory,
  JobOffer,
  JobSummary,
  Message,
  Payment,
  PaymentBreakdown,
  PublicProfile,
  ReputationSnapshot,
  Review,
  WorkerProfile,
} from "@/lib/domain/types";

/**
 * Mapeo fila → entidad de dominio.
 *
 * Único punto donde el modelo relacional toca el modelo de dominio. Si cambia una
 * columna, se corrige aquí y no en veinte componentes.
 */

export interface ProfileRow {
  id: string;
  first_name: string;
  last_name_initial: string | null;
  avatar_url: string | null;
  bio: string | null;
  city: string | null;
  region_code: string | null;
  roles: string[] | null;
  created_at: string;
}

export function mapProfile(row: ProfileRow): PublicProfile {
  return {
    id: row.id,
    firstName: row.first_name,
    lastNameInitial: row.last_name_initial,
    displayName: publicDisplayName(row.first_name, row.last_name_initial),
    avatarUrl: row.avatar_url,
    bio: row.bio,
    city: row.city,
    regionCode: row.region_code,
    memberSince: row.created_at,
    roles: (row.roles ?? ["CLIENT"]) as UserRole[],
  };
}

export interface CategoryRow {
  id: string;
  slug: string;
  category_group: string;
  name: string;
  description: string | null;
  icon: string | null;
  base_hourly_min: number;
  base_hourly_max: number;
  currency: string;
  sort_order: number;
  is_active: boolean;
}

export function mapCategory(row: CategoryRow): JobCategory {
  return {
    id: row.id,
    slug: row.slug,
    group: row.category_group as CategoryGroup,
    name: row.name,
    description: row.description,
    icon: row.icon,
    baseHourlyMin: money(row.base_hourly_min),
    baseHourlyMax: money(row.base_hourly_max),
    sortOrder: row.sort_order,
    isActive: row.is_active,
  };
}

export interface JobRow {
  id: string;
  reference: string;
  client_id: string;
  category_id: string;
  status: string;
  title: string;
  description: string;
  instructions: string | null;
  country_code: string;
  region_code: string;
  commune_code: string;
  place_name: string | null;
  approx_lat: number | null;
  approx_lng: number | null;
  timezone: string | null;
  starts_at: string;
  estimated_duration_minutes: number;
  urgency: string;
  objective_type: string;
  objective_target_position: number | null;
  objective_description: string | null;
  bonus_amount: number | null;
  bonus_conditions: string | null;
  hourly_rate: number;
  currency: string;
  offer_count: number | null;
  view_count: number | null;
  published_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  suggested_hourly_min: number | null;
  suggested_hourly_max: number | null;
}

/** Fila de `job_private_location`. Solo llega si RLS la deja pasar. */
export interface JobPrivateLocationRow {
  job_id: string;
  address_line: string;
  address_notes: string | null;
  lat: number | null;
  lng: number | null;
}

export function mapJob(
  row: JobRow,
  category: JobCategory,
  client: PublicProfile,
  images: Job["images"] = [],
  exactLocation?: JobPrivateLocationRow | null,
): Job {
  const timezone = row.timezone ?? timezoneFor(row.region_code, row.commune_code);
  const hourly = money(row.hourly_rate);

  return {
    id: row.id,
    reference: row.reference,
    clientId: row.client_id,
    client,
    category,
    status: row.status as JobStatus,
    title: row.title,
    description: row.description,
    instructions: row.instructions,
    location: {
      countryCode: row.country_code,
      regionCode: row.region_code,
      regionName: regionName(row.region_code),
      communeCode: row.commune_code,
      communeName: communeName(row.commune_code),
      placeName: row.place_name,
      approxLat: row.approx_lat,
      approxLng: row.approx_lng,
      // Si RLS no dejó pasar la fila privada, aquí queda `null` y la interfaz
      // no tiene de dónde sacar la dirección aunque quisiera.
      exact: exactLocation
        ? {
            addressLine: exactLocation.address_line,
            addressNotes: exactLocation.address_notes,
            lat: exactLocation.lat,
            lng: exactLocation.lng,
          }
        : null,
    },
    timezone,
    startsAt: row.starts_at,
    estimatedDurationMinutes: row.estimated_duration_minutes,
    isOvernight: isOvernight(row.starts_at, row.estimated_duration_minutes, timezone),
    urgency: row.urgency as JobUrgency,
    objective: {
      type: row.objective_type as JobObjectiveType,
      targetPosition: row.objective_target_position,
      description: row.objective_description,
      bonus: row.bonus_amount ? money(row.bonus_amount) : null,
      bonusConditions: row.bonus_conditions,
    },
    proposedHourlyRate: hourly,
    proposedTotal: proratePerHour(hourly, row.estimated_duration_minutes),
    suggestedHourlyMin: money(row.suggested_hourly_min ?? row.hourly_rate),
    suggestedHourlyMax: money(row.suggested_hourly_max ?? row.hourly_rate),
    images,
    offerCount: row.offer_count ?? 0,
    viewCount: row.view_count ?? 0,
    publishedAt: row.published_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapJobSummary(job: Job): JobSummary {
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

export interface WorkerProfileRow {
  user_id: string;
  headline: string | null;
  verification_status: string;
  level: string;
  trust_index: number | null;
  base_hourly_rate: number;
  availability_note: string | null;
  accepts_overnight: boolean;
  is_accepting_jobs: boolean;
  identity_verified: boolean;
  phone_verified: boolean;
  bank_account_verified: boolean;
  email_verified: boolean;
  average_rating: number | null;
  review_count: number | null;
  completed_jobs: number | null;
  worked_minutes: number | null;
  punctuality_rate: number | null;
  completion_rate: number | null;
  cancellation_count: number | null;
  communication_rate: number | null;
  response_minutes_median: number | null;
}

export function mapWorkerProfile(
  row: WorkerProfileRow,
  profile: PublicProfile,
  categories: readonly string[] = [],
  serviceAreas: WorkerProfile["serviceAreas"] = [],
): WorkerProfile {
  const accountAgeDays = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(profile.memberSince)) / 86_400_000),
  );

  const reputation: ReputationSnapshot = {
    averageRating: row.average_rating ?? 0,
    reviewCount: row.review_count ?? 0,
    completedJobs: row.completed_jobs ?? 0,
    workedMinutes: row.worked_minutes ?? 0,
    punctualityRate: row.punctuality_rate ?? 0,
    completionRate: row.completion_rate ?? 0,
    cancellationCount: row.cancellation_count ?? 0,
    communicationRate: row.communication_rate ?? 0,
    accountAgeDays,
    responseMinutesMedian: row.response_minutes_median,
  };

  return {
    userId: row.user_id,
    profile,
    headline: row.headline,
    verificationStatus: row.verification_status as VerificationStatus,
    level: row.level as WorkerLevel,
    trustIndex: row.trust_index ?? 0,
    baseHourlyRate: money(row.base_hourly_rate),
    categories,
    serviceAreas,
    availabilityNote: row.availability_note,
    acceptsOvernight: row.accepts_overnight,
    reputation,
    trust: {
      identityVerified: row.identity_verified,
      phoneVerified: row.phone_verified,
      bankAccountVerified: row.bank_account_verified,
      emailVerified: row.email_verified,
    },
    isAcceptingJobs: row.is_accepting_jobs,
  };
}

export interface OfferRow {
  id: string;
  job_id: string;
  worker_id: string;
  status: string;
  hourly_rate: number;
  estimated_total: number;
  message: string | null;
  estimated_arrival_at: string | null;
  created_at: string;
  responded_at: string | null;
}

export function mapOffer(row: OfferRow, worker: WorkerProfile): JobOffer {
  return {
    id: row.id,
    jobId: row.job_id,
    workerId: row.worker_id,
    worker,
    status: row.status as OfferStatus,
    hourlyRate: money(row.hourly_rate),
    estimatedTotal: money(row.estimated_total),
    message: row.message,
    estimatedArrivalAt: row.estimated_arrival_at,
    createdAt: row.created_at,
    respondedAt: row.responded_at,
  };
}

export interface ReviewRow {
  id: string;
  assignment_id: string;
  author_id: string;
  subject_id: string;
  punctuality: number;
  communication: number;
  compliance: number;
  overall: number;
  comment: string | null;
  created_at: string;
  author_first_name: string | null;
  author_last_name_initial: string | null;
  author_avatar_url: string | null;
}

export function mapReview(row: ReviewRow): Review {
  return {
    id: row.id,
    assignmentId: row.assignment_id,
    authorId: row.author_id,
    authorName: publicDisplayName(
      row.author_first_name ?? "Usuario",
      row.author_last_name_initial,
    ),
    authorAvatarUrl: row.author_avatar_url,
    subjectId: row.subject_id,
    punctuality: row.punctuality,
    communication: row.communication,
    compliance: row.compliance,
    overall: row.overall,
    comment: row.comment,
    createdAt: row.created_at,
  };
}

/* --------------------------------------------------------- Etapa 2: mapeos */

export interface AssignmentRow {
  id: string;
  job_id: string;
  offer_id: string;
  worker_id: string;
  client_id: string;
  status: string;
  agreed_hourly_rate: number;
  agreed_duration_minutes: number;
  agreed_total: number;
  bonus_amount: number;
  bonus_awarded: boolean | null;
  started_at: string | null;
  checked_in_at: string | null;
  handoff_completed_at: string | null;
  completed_at: string | null;
  dispute_deadline_at: string | null;
  created_at: string;
}

export function mapAssignment(row: AssignmentRow): Assignment {
  return {
    id: row.id,
    jobId: row.job_id,
    offerId: row.offer_id,
    workerId: row.worker_id,
    clientId: row.client_id,
    status: row.status as AssignmentStatus,
    agreedHourlyRate: money(row.agreed_hourly_rate),
    agreedDurationMinutes: row.agreed_duration_minutes,
    agreedTotal: money(row.agreed_total),
    bonus: row.bonus_amount > 0 ? money(row.bonus_amount) : null,
    bonusAwarded: row.bonus_awarded,
    startedAt: row.started_at,
    checkedInAt: row.checked_in_at,
    handoffCompletedAt: row.handoff_completed_at,
    completedAt: row.completed_at,
    disputeDeadlineAt: row.dispute_deadline_at,
    createdAt: row.created_at,
  };
}

export interface PaymentRow {
  id: string;
  job_id: string;
  assignment_id: string | null;
  extension_id: string | null;
  client_id: string;
  purpose: string;
  status: string;
  amount: number;
  provider: string;
  provider_transaction_id: string | null;
  authorized_at: string | null;
  paid_at: string | null;
  created_at: string;
}

export function mapPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    jobId: row.job_id,
    assignmentId: row.assignment_id,
    extensionId: row.extension_id,
    clientId: row.client_id,
    purpose: row.purpose as PaymentPurpose,
    status: row.status as PaymentStatus,
    amount: money(row.amount),
    provider: row.provider,
    providerTransactionId: row.provider_transaction_id,
    authorizedAt: row.authorized_at,
    paidAt: row.paid_at,
    createdAt: row.created_at,
  };
}

export interface PaymentSummaryRow {
  assignment_id: string;
  service_amount: number;
  bonus_amount: number;
  commission_bps: number;
  commission_amount: number;
  worker_receives: number;
  client_total: number;
  payment_id: string | null;
  payment_status: string | null;
}

export function mapPaymentBreakdown(row: PaymentSummaryRow): PaymentBreakdown {
  return {
    serviceAmount: money(row.service_amount),
    bonusAmount: money(row.bonus_amount),
    commissionAmount: money(row.commission_amount),
    commissionBps: row.commission_bps,
    workerReceives: money(row.worker_receives),
    clientTotal: money(row.client_total),
  };
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string | null;
  message_type: string;
  body: string | null;
  image_url: string | null;
  read_at: string | null;
  created_at: string;
}

export function mapMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    type: row.message_type as MessageType,
    body: row.body,
    imageUrl: row.image_url,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

export interface NotificationRow {
  id: string;
  user_id: string;
  notification_type: string;
  title: string;
  body: string;
  href: string | null;
  job_id: string | null;
  read_at: string | null;
  created_at: string;
}

export function mapNotification(row: NotificationRow): AppNotification {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.notification_type as NotificationType,
    title: row.title,
    body: row.body,
    href: row.href,
    jobId: row.job_id,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}
