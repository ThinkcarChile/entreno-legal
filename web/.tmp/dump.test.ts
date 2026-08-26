import { writeFileSync } from "node:fs";
import { it } from "vitest";
import { LOTE_A } from "@/domain/recipes/library";
it("vuelca el LOTE A a JSON", () => {
  writeFileSync(".tmp/lote-a.json", JSON.stringify(LOTE_A, null, 2), "utf8");
});
