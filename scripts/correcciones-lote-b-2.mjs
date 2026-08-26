#!/usr/bin/env node
/** Segunda pasada de correcciones al LOTE B: los MEDIOS de cocina que quedaban. */
import { readFileSync, writeFileSync } from "node:fs";
const RUTA = ".plan/lote-b-recetas.json";
const recetas = JSON.parse(readFileSync(RUTA, "utf8"));
const receta = (s) => recetas.find((x) => x.slug === s);
const cambios = [];

{
  // 110 g de cebolla CRUDA en 500 g de carne es demasiada agua: las albóndigas
  // se desarman al dorarlas. La cebolla de la masa va sofrita y fría.
  const r = receta("albondigas-en-salsa-de-tomate");
  const c = r.components.find((x) => x.ingredient === "cebolla");
  c.notes = "la mayor parte va a la salsa; a la masa van unos 50 g y SOFRITOS Y FRÍOS — cruda suelta agua y las albóndigas se desarman al dorarlas";
  const paso = r.steps.find((p) => /masa|amasa|mezcla/i.test(p.instruction));
  if (paso) {
    paso.instruction = paso.instruction.replace(/$/, " La cebolla que va dentro de la masa tiene que estar sofrita y fría: cruda moja la mezcla.");
  }
  cambios.push("albóndigas: la cebolla de la masa va sofrita y fría, y baja a ~50 g (cruda desarma las albóndigas)");
}
{
  const r = receta("pastel-de-papas");
  r.cookMinutes = 62;
  cambios.push("pastel-de-papas: cookMinutes 45→62 (25 de papas + 12 de pino + 25 de horno, aunque las papas corran en paralelo)");

  // La nota negaba la versión más común del plato en Chile.
  for (const c of r.components) {
    if (c.notes?.includes("NO va huevo duro")) {
      c.notes = "acá el pino va simple; si en tu casa lo hacen con huevo duro y aceituna, van repartidos sobre el pino antes de tapar con el puré";
    }
  }
  if (!r.components.some((c) => c.ingredient === "huevo de gallina" && c.optional)) {
    r.components.push({
      ingredient: "huevo de gallina", quantity: 2, unit: "UNIT", basis: "EDIBLE_PORTION",
      slot: "TOPPING", role: "MAIN", adjustability: "OPTIONAL", optional: true,
      cookingMethod: "BOILED",
      notes: "huevo duro en gajos sobre el pino: es como lo hace buena parte de las casas chilenas",
    });
  }
  cambios.push("pastel-de-papas: el huevo duro deja de estar negado y entra como componente OPCIONAL (es la versión más común en Chile)");
}

writeFileSync(RUTA, JSON.stringify(recetas, null, 2), "utf8");
console.log(cambios.map((c) => "  · " + c).join("\n"));
