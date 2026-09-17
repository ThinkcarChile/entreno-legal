import { JobStatus } from "@/lib/domain/enums";
import { money } from "@/lib/utils/money";

import { demoCategories } from "./categories";
import { demoJobs, demoOffers, demoReviews, demoTimeline, toSummary } from "./jobs";
import { demoProfiles, demoWorkers } from "./people";

import type {
  AdminRepository,
  CategoryRepository,
  DataAccess,
  JobFilters,
  JobRepository,
  NotificationRepository,
  Page,
  PlatformKpis,
  ProfileRepository,
  WorkerRepository,
} from "../repositories";
import type {
  AppNotification,
  Job,
  JobCategory,
  JobOffer,
  JobSummary,
  JobTimelineEntry,
  PublicProfile,
  Review,
  WorkerProfile,
} from "@/lib/domain/types";

export { demoCategories } from "./categories";
export { demoFeaturedReviews, demoJobs, toSummary } from "./jobs";
export { demoWorkers, demoClients } from "./people";

/**
 * Implementación de demostración.
 *
 * Se usa cuando no hay credenciales de Supabase. Cumple exactamente los mismos
 * contratos que la implementación real, así que la UI no distingue entre ambas.
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
    if (filters.regionCode) {
      items = items.filter((j) => j.location.regionCode === filters.regionCode);
    }
    if (filters.communeCode) {
      items = items.filter((j) => j.location.communeCode === filters.communeCode);
    }
    if (filters.urgency) {
      items = items.filter((j) => j.urgency === filters.urgency);
    }
    if (filters.overnightOnly) {
      items = items.filter((j) => j.isOvernight);
    }
    if (filters.minHourlyRate) {
      items = items.filter((j) => j.proposedHourlyRate.amount >= filters.minHourlyRate!);
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
    const total = items.length;

    return {
      items: items.slice(offset, offset + limit).map(toSummary),
      total,
      limit,
      offset,
    };
  }

  async getById(id: string): Promise<Job | null> {
    return demoJobs().find((j) => j.id === id) ?? null;
  }

  async getByReference(reference: string): Promise<Job | null> {
    return demoJobs().find((j) => j.reference === reference) ?? null;
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
    default:
      return copy.sort(
        (a, b) => Date.parse(b.publishedAt ?? b.createdAt) - Date.parse(a.publishedAt ?? a.createdAt),
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
}

class DemoProfileRepository implements ProfileRepository {
  async getPublicProfile(userId: string): Promise<PublicProfile | null> {
    return demoProfiles.find((p) => p.id === userId) ?? null;
  }
}

class DemoNotificationRepository implements NotificationRepository {
  async listForUser(): Promise<readonly AppNotification[]> {
    return [];
  }
  async unreadCount(): Promise<number> {
    return 0;
  }
}

class DemoAdminRepository implements AdminRepository {
  async getKpis(): Promise<PlatformKpis> {
    return {
      gmv: money(48_320_000),
      platformRevenue: money(7_248_000),
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
}

export function createDemoDataAccess(): DataAccess {
  return {
    source: "demo",
    categories: new DemoCategoryRepository(),
    jobs: new DemoJobRepository(),
    workers: new DemoWorkerRepository(),
    profiles: new DemoProfileRepository(),
    notifications: new DemoNotificationRepository(),
    admin: new DemoAdminRepository(),
  };
}
