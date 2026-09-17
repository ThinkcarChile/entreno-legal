import { mapMessage, mapNotification, type MessageRow, type NotificationRow } from "./mappers";
import { loadProfiles } from "./jobs";
import { currentUserId, type Client } from "./shared";

import type { ConversationRepository, NotificationRepository } from "../repositories";
import type { JobStatus } from "@/lib/domain/enums";
import type {
  AppNotification,
  ConversationDetail,
  ConversationSummary,
} from "@/lib/domain/types";

interface ConversationRow {
  id: string;
  job_id: string;
  assignment_id: string | null;
  client_id: string;
  worker_id: string;
  offer_id: string | null;
  is_primary: boolean;
  last_message_at: string | null;
  created_at: string;
}

const CONVERSATION_COLUMNS =
  "id,job_id,assignment_id,client_id,worker_id,offer_id,is_primary,last_message_at,created_at";

/**
 * Mensajería.
 *
 * RLS ya impide leer conversaciones ajenas; estos métodos no reciben el
 * identificador del usuario por parámetro, así que tampoco hay forma de pedir
 * "las conversaciones de otro".
 */
export class SupabaseConversationRepository implements ConversationRepository {
  constructor(private readonly getClient: () => Promise<Client>) {}

  async listMine(): Promise<readonly ConversationSummary[]> {
    const supabase = await this.getClient();
    const userId = await currentUserId(supabase);
    if (!userId) return [];

    const { data, error } = await supabase
      .from("conversations")
      .select(CONVERSATION_COLUMNS)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .returns<ConversationRow[]>();

    if (error) throw error;
    const rows = data ?? [];
    if (rows.length === 0) return [];

    const jobIds = [...new Set(rows.map((r) => r.job_id))];
    const counterpartIds = rows.map((r) => (r.client_id === userId ? r.worker_id : r.client_id));

    const [jobsResult, profiles, lastMessages, unreadCounts] = await Promise.all([
      supabase
        .from("jobs")
        .select("id,title,status")
        .in("id", jobIds)
        .returns<{ id: string; title: string; status: string }[]>(),
      loadProfiles(supabase, counterpartIds),
      this.loadLastMessages(supabase, rows.map((r) => r.id)),
      this.loadUnreadCounts(supabase, rows.map((r) => r.id), userId),
    ]);

    const jobById = new Map((jobsResult.data ?? []).map((j) => [j.id, j]));

    return rows.flatMap((row) => {
      const job = jobById.get(row.job_id);
      if (!job) return [];
      const counterpartId = row.client_id === userId ? row.worker_id : row.client_id;
      const counterpart = profiles.get(counterpartId);
      const last = lastMessages.get(row.id);

      return [
        {
          id: row.id,
          jobId: row.job_id,
          jobTitle: job.title,
          jobStatus: job.status as JobStatus,
          assignmentId: row.assignment_id,
          isPrimary: row.is_primary,
          counterpartId,
          counterpartName: counterpart?.displayName ?? "Usuario",
          counterpartAvatarUrl: counterpart?.avatarUrl ?? null,
          lastMessage: last?.body ?? null,
          lastMessageAt: row.last_message_at,
          unreadCount: unreadCounts.get(row.id) ?? 0,
        } satisfies ConversationSummary,
      ];
    });
  }

  async getById(conversationId: string): Promise<ConversationDetail | null> {
    const supabase = await this.getClient();
    const userId = await currentUserId(supabase);
    if (!userId) return null;

    const { data: row, error } = await supabase
      .from("conversations")
      .select(CONVERSATION_COLUMNS)
      .eq("id", conversationId)
      .maybeSingle<ConversationRow>();

    if (error) throw error;
    if (!row) return null;

    const counterpartId = row.client_id === userId ? row.worker_id : row.client_id;

    const [jobResult, profiles, messagesResult] = await Promise.all([
      supabase
        .from("jobs")
        .select("id,title,status")
        .eq("id", row.job_id)
        .maybeSingle<{ id: string; title: string; status: string }>(),
      loadProfiles(supabase, [counterpartId]),
      supabase
        .from("messages")
        .select("*")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true })
        .returns<MessageRow[]>(),
    ]);

    if (!jobResult.data) return null;
    const counterpart = profiles.get(counterpartId);

    return {
      conversation: {
        id: row.id,
        jobId: row.job_id,
        jobTitle: jobResult.data.title,
        jobStatus: jobResult.data.status as JobStatus,
        assignmentId: row.assignment_id,
        isPrimary: row.is_primary,
        counterpartId,
        counterpartName: counterpart?.displayName ?? "Usuario",
        counterpartAvatarUrl: counterpart?.avatarUrl ?? null,
        lastMessage: null,
        lastMessageAt: row.last_message_at,
        unreadCount: 0,
      },
      messages: (messagesResult.data ?? []).map(mapMessage),
      viewerRole: row.client_id === userId ? "client" : "worker",
    };
  }

  private async loadLastMessages(supabase: Client, ids: readonly string[]) {
    const { data } = await supabase
      .from("messages")
      .select("id,conversation_id,body,created_at,message_type,sender_id,image_url,read_at")
      .in("conversation_id", [...ids])
      .order("created_at", { ascending: false })
      .returns<MessageRow[]>();

    const map = new Map<string, MessageRow>();
    for (const row of data ?? []) {
      if (!map.has(row.conversation_id)) map.set(row.conversation_id, row);
    }
    return map;
  }

  private async loadUnreadCounts(
    supabase: Client,
    ids: readonly string[],
    userId: string,
  ): Promise<Map<string, number>> {
    const { data } = await supabase
      .from("messages")
      .select("conversation_id")
      .in("conversation_id", [...ids])
      .is("read_at", null)
      .neq("sender_id", userId)
      .returns<{ conversation_id: string }[]>();

    const counts = new Map<string, number>();
    for (const row of data ?? []) {
      counts.set(row.conversation_id, (counts.get(row.conversation_id) ?? 0) + 1);
    }
    return counts;
  }
}

export class SupabaseNotificationRepository implements NotificationRepository {
  constructor(private readonly getClient: () => Promise<Client>) {}

  async listMine(limit = 30): Promise<readonly AppNotification[]> {
    const supabase = await this.getClient();
    const userId = await currentUserId(supabase);
    if (!userId) return [];

    const { data, error } = await supabase
      .from("notifications")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit)
      .returns<NotificationRow[]>();

    if (error) throw error;
    return (data ?? []).map(mapNotification);
  }

  async unreadCount(): Promise<number> {
    const supabase = await this.getClient();
    const userId = await currentUserId(supabase);
    if (!userId) return 0;

    const { count, error } = await supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .is("read_at", null);

    if (error) throw error;
    return count ?? 0;
  }
}
