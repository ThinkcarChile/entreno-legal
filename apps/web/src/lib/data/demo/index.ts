import { JobStatus } from "@/lib/domain/enums";
import { platform } from "@/config/platform";
import { money } from "@/lib/utils/money";

import { demoCategories } from "./categories";
import {
  demoFeaturedReviews,
  demoJobs,
  demoOffers,
  demoReviews,
  demoTimeline,
  toSummary,
} from "./jobs";
import { demoProfiles, demoWorkers } from "./people";

import type {
  AdminRepository,
  CategoryRepository,
  ConversationRepository,
  DataAccess,
  JobFilters,
  JobRepository,
  NotificationRepository,
  Page,
  PlatformKpis,
  ProfileRepository,
  SessionRepository,
  SettingsRepository,
  WorkerRepository,
} from "../repositories";
import type {
  AppNotification,
  AssignmentDetail,
  ClientJobSummary,
  ConversationDetail,
  ConversationSummary,
  Job,
  JobCategory,
  JobOffer,
  JobSummary,
  JobTimelineEntry,
  PlatformSettings,
  PublicProfile,
  Review,
  SessionUser,
  VerificationRequest,
  WorkerJobSummary,
  WorkerProfile,
} from "@/lib/domain/types";

export { demoCategories } from "./categories";
export { demoFeaturedReviews, demoJobs, toSummary } from "./jobs";
export { demoWorkers, demoClients } from "./people";

/**
 * Implementación de demostración.
 *
 * Es de SOLO LECTURA y sirve para revisar la interfaz sin base de datos. No hay
 * sesión, así que todo lo que depende de un usuario devuelve vacío y la interfaz
 * muestra el aviso correspondiente. Nunca se mezcla con datos reales: el modo se
 * decide una vez, al arrancar, y vale para toda la aplicación.
 */

class DemoCategoryRepository implements CategoryRepository {
  async list(): Promise<readonly JobCategory[]> {
    return demoCategories.filter((c) => c.isActive).sort((a, b) => a.sortOrder - b.sortOrder);
  }
  async getById(id: string): Promise<JobCategory | null> {
    return demoCategories.find((c) => c.id === id) ?? null;
  }
  async getBySlug(slug: string): Promise<JobCategory | null> {
    return demoCategories.find((c) => c.slug === slug) ?? null;
  }
}

class DemoJobRepository implements JobRepository {
  async listOpen(filters: JobFilters = {}): Promise<Page<JobSummary>> {
    const { limit = 20, offset = 0 } = filters;
    let items = demoJobs().filter((job) => job.status === JobStatus.PUBLISHED);

    if (filters.categoryGroup) {
      items = items.filter((j) => j.category.group === filters.categoryGroup);
    }
    if (filters.categoryIds?.length) {
      items = items.filter((j) => filters.categoryIds!.includes(j.category.id));
    }
    if (filters.regionCode) items = items.filter((j) => j.location.regionCode === filters.regionCode);
    if (filters.communeCode) {
      items = items.filter((j) => j.location.communeCode === filters.communeCode);
    }
    if (filters.urgency) items = items.filter((j) => j.urgency === filters.urgency);
    if (filters.overnightOnly) items = items.filter((j) => j.isOvernight);
    if (filters.withBonusOnly) items = items.filter((j) => j.objective.bonus !== null);
    if (filters.minHourlyRate) {
      items = items.filter((j) => j.proposedHourlyRate.amount >= filters.minHourlyRate!);
    }
    if (filters.minTotal) {
      items = items.filter((j) => j.proposedTotal.amount >= filters.minTotal!);
    }
    if (filters.maxDurationMinutes) {
      items = items.filter((j) => j.estimatedDurationMinutes <= filters.maxDurationMinutes!);
    }
    if (filters.fromDate) {
      items = items.filter((j) => j.startsAt >= filters.fromDate!);
    }
    if (filters.toDate) {
      items = items.filter((j) => j.startsAt <= `${filters.toDate!}T23:59:59Z`);
    }
    if (filters.query) {
      const needle = filters.query.toLowerCase();
      items = items.filter(
        (j) =>
          j.title.toLowerCase().includes(needle) ||
          j.description.toLowerCase().includes(needle) ||
          j.location.communeName.toLowerCase().includes(needle),
      );
    }

    items = sortJobs(items, filters.sort ?? "recent");

    return {
      items: items.slice(offset, offset + limit).map(toSummary),
      total: items.length,
      limit,
      offset,
    };
  }

  async getById(id: string): Promise<Job | null> {
    return demoJobs().find((j) => j.id === id) ?? null;
  }

  async listOffers(jobId: string): Promise<readonly JobOffer[]> {
    return demoOffers(jobId);
  }

  async getTimeline(jobId: string): Promise<readonly JobTimelineEntry[]> {
    return demoTimeline(jobId);
  }

  async countByCategory(): Promise<Readonly<Record<string, number>>> {
    const counts: Record<string, number> = {};
    for (const job of demoJobs()) {
      if (job.status !== JobStatus.PUBLISHED) continue;
      counts[job.category.id] = (counts[job.category.id] ?? 0) + 1;
    }
    return counts;
  }

  // Sin sesión no hay "mis trabajos". La interfaz lo explica en pantalla.
  async listMinePublished(): Promise<readonly ClientJobSummary[]> {
    return [];
  }
  async listMineAsWorker(): Promise<readonly WorkerJobSummary[]> {
    return [];
  }
  async getMyOffer(): Promise<JobOffer | null> {
    return null;
  }
  async getAssignment(): Promise<AssignmentDetail | null> {
    return null;
  }
  async getAssignmentByJob(): Promise<AssignmentDetail | null> {
    return null;
  }
}

function sortJobs(jobs: readonly Job[], sort: NonNullable<JobFilters["sort"]>): Job[] {
  const copy = [...jobs];
  switch (sort) {
    case "starts_soon":
      return copy.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
    case "budget_desc":
      return copy.sort((a, b) => b.proposedTotal.amount - a.proposedTotal.amount);
    case "budget_asc":
      return copy.sort((a, b) => a.proposedTotal.amount - b.proposedTotal.amount);
    case "duration_asc":
      return copy.sort((a, b) => a.estimatedDurationMinutes - b.estimatedDurationMinutes);
    default:
      return copy.sort(
        (a, b) =>
          Date.parse(b.publishedAt ?? b.createdAt) - Date.parse(a.publishedAt ?? a.createdAt),
      );
  }
}

class DemoWorkerRepository implements WorkerRepository {
  async getByUserId(userId: string): Promise<WorkerProfile | null> {
    return demoWorkers.find((w) => w.userId === userId) ?? null;
  }
  async listFeatured(limit = 4): Promise<readonly WorkerProfile[]> {
    return [...demoWorkers]
      .filter((w) => w.isAcceptingJobs)
      .sort((a, b) => b.trustIndex - a.trustIndex)
      .slice(0, limit);
  }
  async listReviews(workerId: string, limit = 10): Promise<readonly Review[]> {
    return demoReviews(workerId, limit);
  }
  async listRecentReviews(limit = 3): Promise<readonly Review[]> {
    return demoFeaturedReviews(limit);
  }
}

class DemoProfileRepository implements ProfileRepository {
  async getPublicProfile(userId: string): Promise<PublicProfile | null> {
    return demoProfiles.find((p) => p.id === userId) ?? null;
  }
}

class DemoSessionRepository implements SessionRepository {
  async getSessionUser(): Promise<SessionUser | null> {
    return null;
  }
}

class DemoConversationRepository implements ConversationRepository {
  async listMine(): Promise<readonly ConversationSummary[]> {
    return [];
  }
  async getById(): Promise<ConversationDetail | null> {
    return null;
  }
}

class DemoNotificationRepository implements NotificationRepository {
  async listMine(): Promise<readonly AppNotification[]> {
    return [];
  }
  async unreadCount(): Promise<number> {
    return 0;
  }
}

class DemoSettingsRepository implements SettingsRepository {
  async get(): Promise<PlatformSettings> {
    return {
      commissionBps: platform.commissionBps,
      disputeWindowHours: platform.disputeWindowHours,
      minDurationMinutes: platform.minDurationMinutes,
      loyaltyPointsPer1000: platform.loyaltyPointsPer1000Clp,
      currency: platform.currency,
    };
  }
}

class DemoAdminRepository implements AdminRepository {
  async getKpis(): Promise<PlatformKpis> {
    return {
      gmv: money(48_320_000),
      platformRevenue: money(6_764_800),
      jobsPublished: 1_284,
      jobsCompleted: 1_047,
      averageTicket: money(46_150),
      newUsers30d: 612,
      activeWorkers: 238,
      cancellations: 63,
      openDisputes: 7,
      successRate: 0.94,
      pendingVerifications: 19,
      pendingPayouts: 34,
    };
  }
  async listVerifications(): Promise<readonly VerificationRequest[]> {
    return [];
  }
}

export function createDemoDataAccess(): DataAccess {
  return {
    source: "demo",
    categories: new DemoCategoryRepository(),
    jobs: new DemoJobRepository(),
    workers: new DemoWorkerRepository(),
    profiles: new DemoProfileRepository(),
    session: new DemoSessionRepository(),
    conversations: new DemoConversationRepository(),
    notifications: new DemoNotificationRepository(),
    settings: new DemoSettingsRepository(),
    admin: new DemoAdminRepository(),
  };
}
