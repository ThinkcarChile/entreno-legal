import { notFound } from "next/navigation";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Gate final §7: un parámetro de ruta que NO es un UUID es una URL que no
 * existe — 404 honesto, no un `invalid input syntax for type uuid` de
 * PostgREST reventando en un 500 "Application error". La distinción importa:
 * ERROR = algo nuestro falló; NOT FOUND = esa página no es de nadie.
 */
export function uuidParam(value: string): string {
  if (!UUID_RE.test(value)) notFound();
  return value;
}
