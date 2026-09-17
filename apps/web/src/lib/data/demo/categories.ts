import { CategoryGroup } from "@/lib/domain/enums";
import { money } from "@/lib/utils/money";

import type { JobCategory } from "@/lib/domain/types";

/**
 * Categorías de demostración.
 *
 * Los rangos base coinciden con `pricingRules` y sirven como referencia inicial;
 * el motor de precios aplica los multiplicadores sobre ellos.
 */
export const demoCategories: readonly JobCategory[] = [
  {
    id: "cat-fila-conciertos",
    slug: "filas-conciertos-eventos",
    group: CategoryGroup.FILA,
    name: "Conciertos y eventos",
    description: "Entradas, accesos, meet and greet y filas de espectáculos.",
    icon: "ticket",
    baseHourlyMin: money(8_000),
    baseHourlyMax: money(10_000),
    sortOrder: 1,
    isActive: true,
  },
  {
    id: "cat-fila-lanzamientos",
    slug: "filas-lanzamientos-tiendas",
    group: CategoryGroup.FILA,
    name: "Lanzamientos y tiendas",
    description: "Estrenos de productos, aperturas y ofertas por tiempo limitado.",
    icon: "shopping-bag",
    baseHourlyMin: money(8_000),
    baseHourlyMax: money(10_500),
    sortOrder: 2,
    isActive: true,
  },
  {
    id: "cat-fila-restaurantes",
    slug: "filas-restaurantes",
    group: CategoryGroup.FILA,
    name: "Restaurantes",
    description: "Locales sin reserva y filas de mesa.",
    icon: "utensils",
    baseHourlyMin: money(8_000),
    baseHourlyMax: money(10_000),
    sortOrder: 3,
    isActive: true,
  },
  {
    id: "cat-fila-instituciones",
    slug: "filas-instituciones",
    group: CategoryGroup.FILA,
    name: "Instituciones y servicios",
    description: "Filas de atención presencial en oficinas e instituciones.",
    icon: "building",
    baseHourlyMin: money(8_500),
    baseHourlyMax: money(11_000),
    sortOrder: 4,
    isActive: true,
  },
  {
    id: "cat-fila-overnight",
    slug: "filas-madrugada-overnight",
    group: CategoryGroup.FILA,
    name: "Madrugada y overnight",
    description: "Filas nocturnas y de larga duración, con relevos coordinados.",
    icon: "moon",
    baseHourlyMin: money(11_500),
    baseHourlyMax: money(14_500),
    sortOrder: 5,
    isActive: true,
  },
  {
    id: "cat-tramite-documentos",
    slug: "retiro-entrega-documentos",
    group: CategoryGroup.TRAMITE,
    name: "Documentos",
    description: "Retiro y entrega de documentos cuando el trámite lo permite.",
    icon: "file-text",
    baseHourlyMin: money(9_000),
    baseHourlyMax: money(12_000),
    sortOrder: 6,
    isActive: true,
  },
  {
    id: "cat-tramite-pedidos",
    slug: "retiro-pedidos",
    group: CategoryGroup.TRAMITE,
    name: "Retiro de pedidos",
    description: "Retiro de compras, encomiendas y pedidos listos.",
    icon: "package",
    baseHourlyMin: money(9_000),
    baseHourlyMax: money(11_500),
    sortOrder: 7,
    isActive: true,
  },
  {
    id: "cat-tramite-espera",
    slug: "espera-tecnico-atencion",
    group: CategoryGroup.TRAMITE,
    name: "Esperar atención o técnico",
    description: "Acompañar una espera en domicilio u oficina.",
    icon: "clock",
    baseHourlyMin: money(9_000),
    baseHourlyMax: money(12_000),
    sortOrder: 8,
    isActive: true,
  },
  {
    id: "cat-tramite-otros",
    slug: "otros-encargos",
    group: CategoryGroup.TRAMITE,
    name: "Otros encargos",
    description: "Gestiones presenciales permitidas que no encajan en otra categoría.",
    icon: "list-checks",
    baseHourlyMin: money(9_000),
    baseHourlyMax: money(12_500),
    sortOrder: 9,
    isActive: true,
  },
];

export function findDemoCategory(id: string): JobCategory | undefined {
  return demoCategories.find((c) => c.id === id);
}
