import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Cliente de Supabase falso, en memoria, para probar el retorno y la
 * conciliación sin base.
 *
 * Imita solo lo que usan `return-handler.ts` y `reconcile.ts`: lecturas con
 * `eq`, `is`, `like`, `order`, `limit` y `maybeSingle`, actualizaciones con
 * filtros, y llamadas a funciones. Las funciones no se reimplementan: cada
 * prueba dice qué contesta la base y comprueba con qué argumentos se la llamó.
 * La lógica de la base se prueba donde vive, en `supabase/tests/`.
 */

export type Row = Record<string, unknown>;

export interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

export interface UpdateCall {
  table: string;
  values: Row;
  matched: number;
}

export type RpcHandler = (
  args: Record<string, unknown>,
  db: FakeAdmin,
) => { data?: unknown; error?: { message: string } | null };

type Filter = (row: Row) => boolean;

function likeToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split("%")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

class FakeQuery implements PromiseLike<{ data: unknown; error: null }> {
  private readonly filters: Filter[] = [];
  private patch: Row | null = null;
  private maxRows: number | null = null;

  constructor(
    private readonly db: FakeAdmin,
    private readonly table: string,
  ) {}

  select(): this {
    return this;
  }

  update(values: Row): this {
    this.patch = values;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  is(column: string, value: unknown): this {
    this.filters.push((row) => (row[column] ?? null) === value);
    return this;
  }

  like(column: string, pattern: string): this {
    const re = likeToRegExp(pattern);
    this.filters.push((row) => typeof row[column] === "string" && re.test(row[column] as string));
    return this;
  }

  in(column: string, values: unknown[]): this {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }

  order(): this {
    return this;
  }

  limit(count: number): this {
    this.maxRows = count;
    return this;
  }

  private matching(): Row[] {
    const rows = (this.db.tables[this.table] ?? []).filter((row) =>
      this.filters.every((filter) => filter(row)),
    );
    return this.maxRows === null ? rows : rows.slice(0, this.maxRows);
  }

  async maybeSingle<T = Row>(): Promise<{ data: T | null; error: { message: string } | null }> {
    const rows = this.matching();
    if (rows.length > 1) {
      return { data: null, error: { message: `varias filas en ${this.table}` } };
    }
    return { data: rows[0] ? ({ ...rows[0] } as T) : null, error: null };
  }

  then<R1 = { data: unknown; error: null }, R2 = never>(
    onFulfilled?: ((value: { data: unknown; error: null }) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    let result: { data: unknown; error: null };
    if (this.patch) {
      const rows = this.matching();
      for (const row of rows) Object.assign(row, this.patch);
      this.db.updates.push({ table: this.table, values: this.patch, matched: rows.length });
      result = { data: null, error: null };
    } else {
      result = { data: this.matching().map((row) => ({ ...row })), error: null };
    }
    return Promise.resolve(result).then(onFulfilled, onRejected);
  }
}

export class FakeAdmin {
  readonly rpcCalls: RpcCall[] = [];
  readonly updates: UpdateCall[] = [];

  constructor(
    readonly tables: Record<string, Row[]>,
    private readonly handlers: Record<string, RpcHandler> = {},
  ) {}

  /** Las llamadas a una función, en orden. */
  callsTo(fn: string): Record<string, unknown>[] {
    return this.rpcCalls.filter((call) => call.fn === fn).map((call) => call.args);
  }

  client(): SupabaseClient {
    return {
      from: (table: string) => new FakeQuery(this, table),
      rpc: async (fn: string, args: Record<string, unknown> = {}) => {
        this.rpcCalls.push({ fn, args });
        const handler = this.handlers[fn];
        if (!handler) return { data: null, error: { message: `función inesperada: ${fn}` } };
        const { data = null, error = null } = handler(args, this);
        return { data, error };
      },
    } as unknown as SupabaseClient;
  }
}
