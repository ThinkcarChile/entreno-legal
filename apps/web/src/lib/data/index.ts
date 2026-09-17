import { resolveDataSource } from "@/lib/env";

import { createDemoDataAccess } from "./demo";
import { createSupabaseDataAccess } from "./supabase";

import type { DataAccess } from "./repositories";

export * from "./repositories";

/**
 * Punto único de acceso a datos.
 *
 * Devuelve la implementación real si hay credenciales de Supabase, y la de
 * demostración si no. Nada aguas arriba necesita saber cuál está activa.
 */
export function getData(): DataAccess {
  return resolveDataSource() === "supabase" ? createSupabaseDataAccess() : createDemoDataAccess();
}

export function isDemoMode(): boolean {
  return resolveDataSource() === "demo";
}
