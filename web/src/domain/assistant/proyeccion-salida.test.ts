import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runActionTool, runReadTool } from "./run-tool";
import { claimProposal, crearAlmacenEnMemoria, emitirConfirmationToken } from "./proposal";
import {
  actorDePrueba,
  ambitoAlcanzable,
  capacidadesFalsas,
  dbAccionFalsa,
  herramientaAccion,
  propuestaDePrueba,
  sesionAccion,
  sesionLectura,
  ANA,
  HOGAR_A,
  HOGAR_B,
  LOTE_77,
} from "./dobles-de-prueba";
import type { ScopeResolver } from "./run-tool";
import type { ReadTool, ToolPayload } from "./tool";
import { untrusted } from "./tool";

/**
 * EL PASO 6 DEL RUNNER, Y LOS DOS CORTES DE ÁMBITO QUE NADIE PISABA.
 *
 * La suite tenía 452 tests verdes y estas líneas de producción se podían borrar
 * sin que ninguno se pusiera rojo:
 *
 *   run-tool.ts:173  `const payload = tool.redact(actor, bruto);`
 *   run-tool.ts:176  `if (!salida.success) throw new DataShapeError(...)`
 *   run-tool.ts:97   la rama `DataShapeError` de `traducirError`
 *   run-tool.ts:117  el corte de hogar del camino de LECTURA
 *   run-tool.ts:130  el guard de resolución incompleta (UNKNOWN != ZERO)
 *   run-tool.ts:284  el corte por turno abortado del camino de ACCIÓN
 *
 * El test que decía cubrir el primero —"redact es idempotente"— llama
 * `tool.redact(actor, bruto)` DIRECTO: demuestra algo del doble, no del runner.
 * Acá todo pasa POR `runReadTool`, que es como corre en producción, y por eso
 * sacar cualquiera de esas líneas pone algo rojo.
 *
 * Lo que es de LA COMPUERTA vive en `compuerta.test.ts` y no acá: la atadura del
 * hash y los veredictos de la revalidación tenían copia en los dos archivos, y
 * dos dueños para la misma regla es la trampa de las dos compuertas en chico.
 */

const entradaProyectada = z.object({ lotId: z.string().uuid() }).strict();
type EntradaProyectada = z.infer<typeof entradaProyectada>;

/** Lo que el modelo PUEDE ver. `.strict()`: nada de columnas de más. */
const salidaProyectada = z.array(z.object({ id: z.string(), gramos: z.number() }).strict());
type SalidaProyectada = z.infer<typeof salidaProyectada>;

const SECRETO = "celiaquia confirmada en el examen de julio";

/**
 * Lo que el motor trae de la base: una columna clínica de más. Que el tipo no
 * la admita es justamente el punto — en producción esto llega de un `select` y
 * de un `JSON.parse`, que no respetan tipos. El paso 6 es lo que la ataja.
 */
function filasCrudas(): SalidaProyectada {
  return [{ id: LOTE_77, gramos: 2000, diagnostico: SECRETO }] as unknown as SalidaProyectada;
}

function payloadCrudo(): ToolPayload<SalidaProyectada> {
  return {
    data: filasCrudas(),
    provenance: [{ motor: "stock", version: "stock/1.0.0" }],
    unknowns: [],
    reasons: [],
    labels: { [LOTE_77]: untrusted("Pollo del viernes") },
  };
}

/**
 * Herramienta con proyección de verdad: `redact` deja solo las dos columnas que
 * el `output` describe. Los dos a la vez, que es el contrato del paso 6: el
 * schema tiene que describir lo que el modelo VA A VER.
 */
function herramientaProyectada(
  over: Partial<ReadTool<EntradaProyectada, SalidaProyectada>> = {},
): ReadTool<EntradaProyectada, SalidaProyectada> {
  return {
    name: "stock.de_alimento",
    kind: "READ",
    effect: "NONE",
    risk: "BAJO",
    idempotency: { mode: "PURE" },
    input: entradaProyectada,
    output: salidaProyectada,
    descripcion: "Cuánto queda de un alimento.",
    limiteFilas: 50,
    veredictoNutricional: false,
    scope: (input) => ({
      householdId: HOGAR_A,
      members: [],
      rows: [{ table: "inventory_lots", id: input.lotId }],
    }),
    requires: () => [{ k: "HOUSEHOLD" }],
    redact: (_actor, payload) => ({
      ...payload,
      data: payload.data.map((f) => ({ id: f.id, gramos: f.gramos })),
    }),
    run: async () => payloadCrudo(),
    ...over,
  };
}

describe("paso 6: la proyección mínima corre ADENTRO del runner", () => {
  it("`redact` se aplica de verdad: la columna clínica no sale de la herramienta", async () => {
    const salida = await runReadTool(
      herramientaProyectada(),
      { lotId: LOTE_77 },
      sesionLectura(),
    );

    expect(salida.status).toBe("OK");
    if (salida.status !== "OK") throw new Error("la lectura falló");
    // Ni por `data`, ni por `labels`, ni por ningún rincón del sobre.
    expect(JSON.stringify(salida.payload)).not.toContain(SECRETO);
    expect(salida.payload.data).toEqual([{ id: LOTE_77, gramos: 2000 }]);
  });

  it("la salida se valida contra `tool.output`: lo que no calza es FORMA_INVALIDA, no OK", async () => {
    // El motor devuelve una columna de más y `redact` no la saca. Sin la
    // validación, eso cruza al proveedor tal cual: `.strict()` en un schema que
    // nadie corre no prohíbe nada.
    const tool = herramientaProyectada({ redact: (_actor, payload) => payload });

    const salida = await runReadTool(tool, { lotId: LOTE_77 }, sesionLectura());

    expect(salida).toEqual({
      status: "UNAVAILABLE",
      codigo: "FORMA_INVALIDA",
      // Y NO reintentable: la misma forma mala vuelve igual de mala, y
      // reintentar sería pagar dos veces por el mismo error de programa.
      retryable: false,
    });
  });

  it("una forma inválida se AUDITA como falla, no como lectura sin resultados", async () => {
    // ERROR != VACÍO también en la fila de auditoría: si esto quedara como OK,
    // el día que se investigue una respuesta rara la traza diría que anduvo bien.
    const auditadas: string[] = [];
    const tool = herramientaProyectada({ redact: (_actor, payload) => payload });

    await runReadTool(tool, { lotId: LOTE_77 }, sesionLectura({
      auditar: async (e) => {
        auditadas.push(e.status);
      },
    }));

    expect(auditadas).toEqual(["UNAVAILABLE"]);
  });

  it("el tope de filas sigue vivo después de proyectar: redact recorta columnas, no filas", async () => {
    const muchas: SalidaProyectada = [];
    for (let i = 0; i < 60; i += 1) muchas.push({ id: LOTE_77, gramos: 10 });
    const tool = herramientaProyectada({
      limiteFilas: 50,
      redact: (_actor, payload) => payload,
      run: async () => ({ ...payloadCrudo(), data: muchas }),
    });

    const salida = await runReadTool(tool, { lotId: LOTE_77 }, sesionLectura());
    expect(salida).toEqual({
      status: "UNAVAILABLE",
      codigo: "PAYLOAD_EXCESIVO",
      retryable: false,
    });
  });
});

describe("los dos cortes de ámbito del camino de lectura", () => {
  it("una herramienta sin filas ni integrantes igual muere si el hogar no es el de la sesión", async () => {
    // Con `members: []` y `rows: []` este `if` es el ÚNICO control de hogar que
    // queda: no hay `requireActor` con integrantes ni `resolverAmbito` que lo
    // tape. El actor de la sesión es válido y del hogar A; la herramienta pide
    // el hogar B.
    const tool = herramientaProyectada({
      scope: () => ({ householdId: HOGAR_B, members: [], rows: [] }),
    });

    const salida = await runReadTool(tool, { lotId: LOTE_77 }, sesionLectura());

    expect(salida).toEqual({ status: "NOT_PERMITTED" });
  });

  it("si el resolvedor de ámbito no contesta por todas las filas, no se asume que eran propias", async () => {
    // UNKNOWN != ZERO puro: dos filas preguntadas, una respuesta. Sin el guard,
    // `[true].some(no alcanzable)` da `false` y la lectura pasa como si las dos
    // fueran del hogar.
    const aMedias: ScopeResolver = async (rows) => rows.slice(1).map(() => true);
    const tool = herramientaProyectada({
      scope: (input) => ({
        householdId: HOGAR_A,
        members: [],
        rows: [
          { table: "inventory_lots", id: input.lotId },
          { table: "inventory_lots", id: LOTE_77 },
        ],
      }),
    });

    const salida = await runReadTool(
      tool,
      { lotId: LOTE_77 },
      sesionLectura({ resolverAmbito: aMedias }),
    );

    expect(salida).toEqual({
      status: "UNAVAILABLE",
      codigo: "LECTURA_FALLIDA",
      retryable: true,
    });
  });

  it("y con todas las respuestas, la misma lectura pasa", async () => {
    // El contraste que hace honesto al test de arriba: lo que corta es la
    // respuesta incompleta, no la herramienta.
    const tool = herramientaProyectada({
      scope: (input) => ({
        householdId: HOGAR_A,
        members: [],
        rows: [
          { table: "inventory_lots", id: input.lotId },
          { table: "inventory_lots", id: LOTE_77 },
        ],
      }),
    });

    const salida = await runReadTool(
      tool,
      { lotId: LOTE_77 },
      sesionLectura({
        resolverAmbito: ambitoAlcanzable,
        capacidades: capacidadesFalsas(actorDePrueba()),
      }),
    );

    expect(salida.status).toBe("OK");
  });
});

describe("el turno abortado también corta el camino de ACCIÓN", () => {
  it("con el turno vencido no se llama a la acción: el costo acá es una escritura", async () => {
    // El camino de lectura tenía su test ("el turno cortado no sigue
    // consultando"). El gemelo de `runActionTool` no: y ahí el costo de seguir
    // adelante no es una consulta de más, es una fila en el ledger después de
    // que el turno ya se dio por vencido.
    const store = crearAlmacenEnMemoria();
    const actor = actorDePrueba({ canCook: true });
    const propuesta = propuestaDePrueba();
    await store.crear(propuesta);
    const token = await emitirConfirmationToken(store, propuesta.id, actor, propuesta.expiresAt);

    const reclamo = await claimProposal(
      {
        proposalId: propuesta.id,
        acceptedByMemberId: ANA,
        confirmationToken: token,
        segundoGesto: { k: "NINGUNO" },
      },
      {
        store,
        actor,
        revalidar: async () => ({ veredicto: "IGUAL" }),
        exigirSegundoGesto: async () => ({ k: "NINGUNO" }),
        ahora: propuesta.createdAt,
      },
    );
    expect(reclamo.ok).toBe(true);
    if (!reclamo.ok) throw new Error("no se pudo reclamar la propuesta");

    const control = new AbortController();
    control.abort();
    const db = dbAccionFalsa();

    const salida = await runActionTool(
      herramientaAccion(),
      { lotId: LOTE_77, gramos: 2000 },
      sesionAccion({ signal: control.signal, db, propuestas: store }),
      reclamo.grant,
    );

    expect(salida).toEqual({
      status: "UNAVAILABLE",
      codigo: "TIEMPO_AGOTADO",
      retryable: true,
    });
    // Lo que de verdad importa: no se escribió nada.
    expect(db.llamadas).toEqual([]);
    // Y la llave no se gastó: el turno se cayó, la persona no perdió su gesto.
    expect(reclamo.grant.yaUsado).toBe(false);
  });
});
