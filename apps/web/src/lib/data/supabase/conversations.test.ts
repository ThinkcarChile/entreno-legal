import { describe, expect, it, vi } from "vitest";

// El cliente de servidor lee cookies de Next; aquí se pasa uno falso.
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { SupabaseConversationRepository, SupabaseNotificationRepository } from "./conversations";

import type { Client } from "./shared";

/**
 * RLS deja a la administración leer todas las conversaciones y todos los avisos.
 * La bandeja y los mensajes de un administrador mostraban los de toda la
 * plataforma: cada consulta tiene que filtrar por quien mira, explícitamente.
 */

type Call = [method: string, ...args: unknown[]];

/** Un cliente que anota cada llamada del constructor de consultas. */
function fakeClient(userId: string, rows: unknown[] = []) {
  const calls: Call[] = [];
  const builder: Record<string, unknown> = new Proxy(
    {},
    {
      get(_, prop: string) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void) =>
            resolve({ data: rows, error: null, count: rows.length });
        }
        if (prop === "maybeSingle") {
          return (...args: unknown[]) => {
            calls.push([prop, ...args]);
            return Promise.resolve({ data: rows[0] ?? null, error: null });
          };
        }
        return (...args: unknown[]) => {
          calls.push([prop, ...args]);
          return builder;
        };
      },
    },
  );
  const client = {
    auth: { getClaims: async () => ({ data: { claims: { sub: userId } }, error: null }) },
    from: (table: string) => {
      calls.push(["from", table]);
      return builder;
    },
  } as unknown as Client;
  return { client, calls };
}

describe("solo lo propio, aunque RLS deje ver más", () => {
  it("los avisos se filtran por quien mira", async () => {
    const { client, calls } = fakeClient("u-admin");
    await new SupabaseNotificationRepository(async () => client).listMine();
    expect(calls).toContainEqual(["eq", "user_id", "u-admin"]);
  });

  it("y el recuento de sin leer, también", async () => {
    const { client, calls } = fakeClient("u-admin");
    await new SupabaseNotificationRepository(async () => client).unreadCount();
    expect(calls).toContainEqual(["eq", "user_id", "u-admin"]);
  });

  it("las conversaciones, por cliente o trabajador", async () => {
    const { client, calls } = fakeClient("u-admin");
    await new SupabaseConversationRepository(async () => client).listMine();
    expect(calls).toContainEqual(["or", "client_id.eq.u-admin,worker_id.eq.u-admin"]);
  });

  it("una conversación de otras dos personas no se abre como propia", async () => {
    const ajena = {
      id: "c1",
      job_id: "j1",
      assignment_id: null,
      client_id: "u-cliente",
      worker_id: "u-trabajador",
      offer_id: null,
      is_primary: true,
      last_message_at: null,
      created_at: "2026-01-01T00:00:00Z",
    };
    const { client } = fakeClient("u-admin", [ajena]);
    expect(await new SupabaseConversationRepository(async () => client).getById("c1")).toBeNull();
  });
});
