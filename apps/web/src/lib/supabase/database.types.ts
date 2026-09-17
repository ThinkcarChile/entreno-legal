/**
 * Tipos de la base de datos.
 *
 * En producción este archivo se genera con la CLI de Supabase:
 *
 *   npx supabase gen types typescript --project-id <id> --schema public \
 *     > src/lib/supabase/database.types.ts
 *
 * Mientras no exista un proyecto activo se usa un esquema genérico: permite compilar
 * y mantiene el cliente tipado en su forma, sin inventar columnas que después habría
 * que corregir. Los repositorios fijan la forma real de cada consulta con `.returns<T>()`.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface GenericTable {
  Row: Record<string, unknown>;
  Insert: Record<string, unknown>;
  Update: Record<string, unknown>;
  Relationships: [];
}

export interface GenericView {
  Row: Record<string, unknown>;
  Relationships: [];
}

export interface GenericFunction {
  Args: Record<string, unknown>;
  Returns: unknown;
}

export interface Database {
  public: {
    Tables: Record<string, GenericTable>;
    Views: Record<string, GenericView>;
    Functions: Record<string, GenericFunction>;
    Enums: Record<string, string>;
    CompositeTypes: Record<string, Record<string, unknown>>;
  };
}
