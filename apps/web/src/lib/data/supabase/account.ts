import { UserRole } from "@/lib/domain/enums";

import { mapProfile, type ProfileRow } from "./mappers";
import { loadProfiles, loadWorkers } from "./jobs";
import { currentUserId, PROFILE_COLUMNS, type Client } from "./shared";
import { getVerifiedUser } from "@/lib/supabase/verified-user";

import type {
  CategoryRepository,
  ProfileRepository,
  SessionRepository,
  SettingsRepository,
  WorkerRepository,
} from "../repositories";
import type {
  JobCategory,
  PlatformSettings,
  PublicProfile,
  Review,
  SessionUser,
  WorkerProfile,
} from "@/lib/domain/types";
import type { CategoryRow, ReviewRow } from "./mappers";
import { mapCategory, mapReview } from "./mappers";

/**
 * Sesión, perfiles, trabajadores y configuración.
 */

interface SessionProfileRow extends ProfileRow {
  role: string;
  onboarding_completed_at: string | null;
  commune_code: string | null;
}

export class SupabaseSessionRepository implements SessionRepository {
  constructor(private readonly getClient: () => Promise<Client>) {}

  async getSessionUser(): Promise<SessionUser | null> {
    const supabase = await this.getClient();
    const user = await getVerifiedUser(supabase);
    if (!user) return null;

    const { data: profile } = await supabase
      .from("profiles")
      .select(`${PROFILE_COLUMNS},role,onboarding_completed_at,commune_code`)
      .eq("id", user.id)
      .maybeSingle<SessionProfileRow>();

    if (!profile) return null;

    const modes = (profile.roles ?? ["CLIENT"]) as UserRole[];
    const isWorker = modes.includes(UserRole.WORKER);

    const [workers, unread] = await Promise.all([
      isWorker ? loadWorkers(supabase, [user.id]) : Promise.resolve(new Map()),
      supabase
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .is("read_at", null),
    ]);

    return {
      id: user.id,
      email: user.email,
      profile: mapProfile(profile),
      modes,
      isAdmin: profile.role === UserRole.ADMIN,
      onboardingCompleted: Boolean(profile.onboarding_completed_at),
      worker: (workers.get(user.id) as WorkerProfile | undefined) ?? null,
      unreadNotifications: unread.count ?? 0,
    };
  }
}

export class SupabaseProfileRepository implements ProfileRepository {
  constructor(private readonly getClient: () => Promise<Client>) {}

  async getPublicProfile(userId: string): Promise<PublicProfile | null> {
    const supabase = await this.getClient();
    const profiles = await loadProfiles(supabase, [userId]);
    return profiles.get(userId) ?? null;
  }
}

export class SupabaseWorkerRepository implements WorkerRepository {
  constructor(private readonly getClient: () => Promise<Client>) {}

  async getByUserId(userId: string): Promise<WorkerProfile | null> {
    const supabase = await this.getClient();
    const workers = await loadWorkers(supabase, [userId]);
    return workers.get(userId) ?? null;
  }

  async listFeatured(limit = 4): Promise<readonly WorkerProfile[]> {
    const supabase = await this.getClient();
    const { data, error } = await supabase
      .from("worker_profiles")
      .select("user_id")
      .eq("is_accepting_jobs", true)
      .eq("verification_status", "VERIFIED")
      .order("trust_index", { ascending: false })
      .limit(limit)
      .returns<{ user_id: string }[]>();

    if (error) throw error;
    const ids = (data ?? []).map((r) => r.user_id);
    const workers = await loadWorkers(supabase, ids);
    return ids.map((id) => workers.get(id)).filter((w): w is WorkerProfile => Boolean(w));
  }

  async listReviews(workerId: string, limit = 10): Promise<readonly Review[]> {
    const supabase = await this.getClient();
    const { data, error } = await supabase
      .from("public_reviews")
      .select("*")
      .eq("subject_id", workerId)
      .order("created_at", { ascending: false })
      .limit(limit)
      .returns<ReviewRow[]>();

    if (error) throw error;
    return (data ?? []).map(mapReview);
  }

  /** Reseñas recientes con mejor calificación, para la portada. */
  async listRecentReviews(limit = 3): Promise<readonly Review[]> {
    const supabase = await this.getClient();
    const { data, error } = await supabase
      .from("public_reviews")
      .select("*")
      .gte("overall", 4)
      .not("comment", "is", null)
      .order("created_at", { ascending: false })
      .limit(limit)
      .returns<ReviewRow[]>();

    if (error) throw error;
    return (data ?? []).map(mapReview);
  }
}

export class SupabaseCategoryRepository implements CategoryRepository {
  constructor(private readonly getClient: () => Promise<Client>) {}

  async list(): Promise<readonly JobCategory[]> {
    const supabase = await this.getClient();
    const { data, error } = await supabase
      .from("job_categories")
      .select("*")
      .eq("is_active", true)
      .order("sort_order")
      .returns<CategoryRow[]>();

    if (error) throw error;
    return (data ?? []).map(mapCategory);
  }

  async getById(id: string): Promise<JobCategory | null> {
    const supabase = await this.getClient();
    const { data, error } = await supabase
      .from("job_categories")
      .select("*")
      .eq("id", id)
      .maybeSingle<CategoryRow>();

    if (error) throw error;
    return data ? mapCategory(data) : null;
  }

  async getBySlug(slug: string): Promise<JobCategory | null> {
    const supabase = await this.getClient();
    const { data, error } = await supabase
      .from("job_categories")
      .select("*")
      .eq("slug", slug)
      .maybeSingle<CategoryRow>();

    if (error) throw error;
    return data ? mapCategory(data) : null;
  }
}

interface SettingsRow {
  commission_bps: number;
  dispute_window_hours: number;
  min_duration_minutes: number;
  loyalty_points_per_1000: number;
  currency: string;
}

export class SupabaseSettingsRepository implements SettingsRepository {
  constructor(private readonly getClient: () => Promise<Client>) {}

  async get(): Promise<PlatformSettings> {
    const supabase = await this.getClient();
    const { data, error } = await supabase
      .from("platform_settings")
      .select("*")
      .maybeSingle<SettingsRow>();

    if (error) throw error;
    if (!data) {
      throw new Error("Falta la fila de platform_settings. Aplica las migraciones.");
    }

    return {
      commissionBps: data.commission_bps,
      disputeWindowHours: data.dispute_window_hours,
      minDurationMinutes: data.min_duration_minutes,
      loyaltyPointsPer1000: data.loyalty_points_per_1000,
      currency: data.currency,
    };
  }
}

export { currentUserId };
