import { SupabaseAdminRepository } from "./admin";
import { SupabaseEarningsRepository } from "./earnings";
import {
  SupabaseCategoryRepository,
  SupabaseProfileRepository,
  SupabaseSessionRepository,
  SupabaseSettingsRepository,
  SupabaseWorkerRepository,
} from "./account";
import {
  SupabaseConversationRepository,
  SupabaseNotificationRepository,
} from "./conversations";
import { SupabaseJobRepository } from "./jobs";
import { getClient } from "./shared";

import type { DataAccess } from "../repositories";

/**
 * Implementación real.
 *
 * Cada repositorio vive en su archivo; aquí solo se componen. Todas las
 * lecturas usan la clave anónima y quedan sujetas a RLS.
 */
export function createSupabaseDataAccess(): DataAccess {
  const categories = new SupabaseCategoryRepository(getClient);

  return {
    source: "supabase",
    categories,
    jobs: new SupabaseJobRepository(getClient, categories),
    workers: new SupabaseWorkerRepository(getClient),
    profiles: new SupabaseProfileRepository(getClient),
    session: new SupabaseSessionRepository(getClient),
    conversations: new SupabaseConversationRepository(getClient),
    notifications: new SupabaseNotificationRepository(getClient),
    settings: new SupabaseSettingsRepository(getClient),
    admin: new SupabaseAdminRepository(getClient),
    earnings: new SupabaseEarningsRepository(getClient),
  };
}
