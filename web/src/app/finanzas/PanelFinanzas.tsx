import { Card, Chip, DataRow, Section, type Tono } from "@/components/ui";
import { Monto, MontoAlMenosContado } from "@/components/Monto";
import { motivoDominante } from "@/lib/money-format";
import type { MontoEstado } from "@/lib/money-format";
import { known, negate, unknown, type CurrencyCode, type KnownSubtotal } from "@/domain/finance/money";
import type {
  AccrualBucket,
  BudgetState,
  ForecastWarning,
  FinanceForecastResult,
} from "@/domain/finance/forecast-engine";
import type { PanelFinanzas } from "./queries";

/**
 * EL PANEL: LAS TRES CIFRAS SEPARADAS.
 *
 * Caja, consumo económico y valor guardado son TRES COSAS DISTINTAS, y
 * confundirlas es el error que este sprint existe para evitar. Cuando la persona
 * ve «salió del bolsillo $142.300, se consumió $96.480, quedaron $45.820 en la
 * despensa», entiende el principio contable sin que nadie se lo explique.
 *
 * [H4] La identidad se muestra COMO IDENTIDAD, no como una lista de cifras
 * sueltas. La versión del diseño ponía «Se consumió realmente $96.480» y abajo
 * «Se botó $8.140» sin decir si lo segundo estaba dentro de lo primero: las dos
 * lecturas daban resultados distintos y ninguna estaba escrita. Acá «Se comió»,
 * «Se botó» y «Pérdida por ajuste» son restas hermanas, cada una con su signo, y
 * el cierre es una fila de cuadre.
 *
 * [H7] «Tu despensa vale hoy $X» y «este mes guardaste +$45.820» son DOS FILAS
 * distintas y rotuladas. Nunca una sola cifra sirviendo de las dos cosas.
 *
 * Nada acá renderiza una acción de «consumir» o «cocinar»: el costo de la merma
 * se muestra como HECHO CONSUMADO. Ponerle precio a lo que se va a vencer, al
 * lado de un botón, es empujar a comerse algo que el motor clínico ya condenó.
 */

const TONO_ESTADO: Record<BudgetState, Tono> = {
  ON_TRACK: "primario",
  AT_RISK: "atencion",
  OVER: "peligro",
  NO_BUDGET: "neutro",
  UNKNOWN_COVERAGE: "info",
};

const ETIQUETA_ESTADO: Record<BudgetState, string> = {
  ON_TRACK: "Vas bien",
  AT_RISK: "Vas apretado",
  OVER: "Te pasaste",
  NO_BUDGET: "Sin presupuesto",
  UNKNOWN_COVERAGE: "No podemos decirte",
};

const NOMBRE_CATEGORIA: Record<string, string> = {
  CONSUMED: "Se comió",
  WASTED_AVOIDABLE: "Se botó (evitable)",
  WASTED_EXPECTED: "Merma esperada (cáscaras, huesos)",
  WASTED_THIRD_PARTY: "Llegó malo o dañado",
  ADJUSTMENT_LOSS: "Pérdida por ajuste",
  CORRECTION: "Correcciones",
  NON_CAPITALIZED_EXPENSE: "Despacho y otros gastos",
};

function dato(valor: FinanceForecastResult["cash"]["total"]): MontoEstado {
  return { estado: "DATO", valor };
}

/** Cómo se nombra en pantalla lo que falta de una cubeta del período. */
const FALTAN_MOVIMIENTOS = (cuantos: number) =>
  cuantos === 1 ? "movimiento sin costear" : "movimientos sin costear";

/**
 * UNA SALIDA DE LA DESPENSA, PINTADA SIN MENTIR.
 *
 * Acá estaba el defecto que este sprint existe para impedir: la fila decía
 * `−{formatMoney(b.known)}`, o sea el SUBTOTAL de lo conocido con un signo
 * menos adelante. Cuando la categoría entera estaba sin costear, `known` valía
 * $0 y la pantalla mostraba «−$0» con un chip «3 sin costear» al lado: un cero
 * CONOCIDO donde la verdad era «no lo sabemos». Las tres ramas de abajo son las
 * tres verdades posibles, y ninguna se puede escribir con `formatMoney` suelto.
 */
function MontoDeCategoria({ b, currency }: { b: AccrualBucket; currency: CurrencyCode }) {
  const motivo = motivoDominante(b.unknownReasons);

  // Nada sin costear: es un total y se muestra como total, con su signo.
  if (b.unknownCount === 0) {
    return <Monto valor={dato(known(negate(b.known)))} />;
  }

  // NADA costeado: no hay número que mostrar. «$0» acá es la mentira exacta.
  if (b.knownCount === 0) {
    return <Monto valor={dato(unknown(motivo))} />;
  }

  // Una parte sí y otra no: «al menos», pegado a cuántos faltan y por qué.
  const subtotal: KnownSubtotal = {
    kind: "KnownSubtotal",
    currency,
    minorAtLeast: negate(b.known).minor,
    knownCount: b.knownCount,
    missingCount: b.unknownCount,
  };
  return (
    <MontoAlMenosContado
      subtotal={subtotal}
      faltan={{
        cuantos: b.unknownCount,
        que: FALTAN_MOVIMIENTOS(b.unknownCount),
        motivo,
      }}
    />
  );
}

/**
 * EL TITULAR DEL CONSUMO.
 *
 * Con todo costeado es un total. Con algo sin costear NO es «Valor
 * desconocido» a secas —que tira a la basura lo que sí se sabe— sino «al menos
 * $X, y faltan N»: la maquinaria del sprint (`KnownSubtotal` + el peaje de los
 * faltantes) usada donde la persona la ve, que era justo lo que no pasaba.
 */
function TotalConsumido({
  f,
  currency,
}: {
  f: FinanceForecastResult;
  currency: CurrencyCode;
}) {
  if (f.economicConsumption.total.known) {
    return (
      <Monto valor={dato(known(negate(f.economicConsumption.total.amount)))} tamano="titular" />
    );
  }
  let conocidas = 0;
  let faltan = 0;
  const motivos: ReturnType<typeof motivoDominante>[] = [];
  for (const b of f.economicConsumption.byCategory) {
    conocidas += b.knownCount;
    faltan += b.unknownCount;
    for (const r of b.unknownReasons) motivos.push(r);
  }
  // Sin UNA sola asignación costeada no hay piso que declarar: «al menos $0» es
  // el mismo cero disfrazado, con otra tipografía.
  if (conocidas === 0) {
    return <Monto valor={dato(unknown(motivoDominante(motivos)))} tamano="titular" />;
  }
  const subtotal: KnownSubtotal = {
    kind: "KnownSubtotal",
    currency,
    minorAtLeast: negate(f.economicConsumption.knownSubtotal).minor,
    knownCount: conocidas,
    missingCount: faltan,
  };
  return (
    <MontoAlMenosContado
      subtotal={subtotal}
      tamano="titular"
      faltan={{ cuantos: faltan, que: FALTAN_MOVIMIENTOS(faltan), motivo: motivoDominante(motivos) }}
    />
  );
}

/**
 * Los avisos del motor, EN PANTALLA.
 *
 * El motor los calculaba y nadie los renderizaba: `SHORTFALLS_NOT_COSTED`,
 * `LATE_RECOGNITION`, `STALE_PRICES` y `UNKNOWN_COVERAGE` morían dentro del
 * objeto. Un aviso que no llega a la persona no es un aviso.
 */
function textoAviso(w: ForecastWarning): { titulo: string; detalle: string; tono: Tono } {
  if (w.code === "SHORTFALLS_NOT_COSTED") {
    return {
      titulo: `${w.count} ${w.count === 1 ? "salida" : "salidas"} de la despensa sin costear`,
      detalle:
        "Salió comida sin que se le pudiera poner precio: lo consumido de arriba es un piso, no el total.",
      tono: "atencion",
    };
  }
  if (w.code === "LATE_RECOGNITION") {
    return {
      titulo: `${w.count} ${w.count === 1 ? "movimiento" : "movimientos"} de meses anteriores se reconocieron en este`,
      detalle:
        "Ocurrieron antes y recién ahora se supo cuánto costaron, así que engordan este mes y no aquel.",
      tono: "info",
    };
  }
  if (w.code === "STALE_PRICES") {
    return {
      titulo: `${w.count} ${w.count === 1 ? "precio" : "precios"} con más de ${w.maxAgeDays} días`,
      detalle: "No entran a la proyección: estimar con un precio viejo es estimar con ficción.",
      tono: "atencion",
    };
  }
  if (w.code === "STORED_VALUE_DOES_NOT_RECONCILE") {
    return {
      titulo: "El valor guardado no cuadra",
      detalle:
        "La apertura más lo capitalizado menos las salidas no da el cierre. Revisa el informe de integridad.",
      tono: "peligro",
    };
  }
  return {
    titulo: "No podemos calcular la cobertura del mes",
    detalle:
      "Faltan precios y no hay forma de saber cuánto pesan en el total, así que no encendemos ningún semáforo.",
    tono: "info",
  };
}

export function PanelFinanzas({ panel }: { panel: PanelFinanzas }) {
  const f = panel.pronostico;

  return (
    <>
      {/* Los avisos van ARRIBA de las cifras que afectan: un aviso bajo el
          pliegue es medio aviso, y estos son justamente los que dicen «este
          número es un piso, no un total». */}
      {f.warnings.length > 0 && (
        <Section title="Antes de leer las cifras" hint="Lo que puede estar faltando">
          <div className="flex flex-col gap-sm">
            {f.warnings.map((w) => {
              const t = textoAviso(w);
              return (
                <Card key={w.code} className="flex flex-col gap-xs px-md py-md">
                  <div className="flex items-center justify-between gap-sm">
                    <span className="font-title-md text-title-md text-on-surface">{t.titulo}</span>
                    <Chip tono={t.tono}>Revisar</Chip>
                  </div>
                  <p className="font-body-md text-body-md text-on-surface-variant">{t.detalle}</p>
                  {w.code === "LATE_RECOGNITION" && f.lateRecognitions.occurredPeriods.length > 0 && (
                    <p className="font-body-sm text-body-sm text-on-surface-variant">
                      Ocurrieron en: {f.lateRecognitions.occurredPeriods.join(", ")}.
                    </p>
                  )}
                </Card>
              );
            })}
          </div>
        </Section>
      )}

      <Section
        title="Este mes"
        hint={`${panel.periodo.startsOn} al ${panel.periodo.endsOn}`}
      >
        <Card className="flex flex-col gap-sm px-md py-md">
          <DataRow label="Salió del bolsillo (caja)">
            <Monto valor={dato(f.cash.total)} tamano="titular" />
            <span className="mt-0.5 block font-body-sm text-body-sm text-on-surface-variant">
              {f.cash.purchases} {f.cash.purchases === 1 ? "compra" : "compras"}
            </span>
          </DataRow>

          <DataRow label="De eso, quedó en la despensa">
            <Monto valor={dato(f.cash.capitalized)} />
          </DataRow>

          {/* [H12] La fila que faltaba: el despacho y la propina salieron del
              bolsillo y NUNCA entraron a la despensa. Sin mostrarla, el valor
              guardado queda inflado por exactamente ese monto. */}
          <DataRow label="Gasto que no queda en la despensa">
            <Monto valor={dato(f.cash.expensedOnly)} />
          </DataRow>
        </Card>
      </Section>

      <Section title="Se consumió de verdad" hint="Lo que efectivamente salió de la despensa">
        <Card className="flex flex-col gap-sm px-md py-md">
          {f.economicConsumption.byCategory.length === 0 && (
            <p className="font-body-md text-body-md text-on-surface-variant">
              Todavía no hay consumo registrado en este período.
            </p>
          )}
          {f.economicConsumption.byCategory.map((b) => (
            <DataRow key={b.category} label={NOMBRE_CATEGORIA[b.category] ?? b.category}>
              <MontoDeCategoria b={b} currency={panel.currency} />
              {/* El desconocido viaja SIEMPRE al lado del subtotal: sin él, el
                  número de arriba se lee como completo. */}
              {b.unknownCount > 0 && (
                <span className="ml-sm">
                  <Chip tono="info" icon="help">
                    {b.unknownCount} sin costear
                  </Chip>
                </span>
              )}
            </DataRow>
          ))}
          <DataRow label="Total consumido">
            <TotalConsumido f={f} currency={panel.currency} />
          </DataRow>
        </Card>
      </Section>

      <Section title="El valor guardado" hint="El saldo y la variación son dos cosas distintas">
        <Card className="flex flex-col gap-sm px-md py-md">
          {/* [H7] SALDO. */}
          <DataRow label="Tu despensa vale hoy">
            <Monto valor={dato(f.storedValue.closingBalance)} tamano="titular" />
          </DataRow>
          {/* [H7] VARIACIÓN. Es `capitalizado − salidas`, jamás `caja − consumo`. */}
          <DataRow label="Este mes guardaste">
            <Monto valor={dato(f.storedValueDelta)} />
          </DataRow>
          {f.storedValue.reconciles === false && (
            <p className="font-body-sm text-body-sm text-error">
              El saldo de cierre no cuadra con el movimiento del mes. Revisa el informe de
              integridad antes de confiar en estas cifras.
            </p>
          )}
        </Card>
      </Section>

      <Section title="Presupuesto" hint="Uno por cada cosa que se mide: caja y consumo">
        <div className="flex flex-col gap-sm">
          {f.budgets.map((v) => (
            <Card key={v.basis} className="flex flex-col gap-xs px-md py-md">
              <div className="flex items-center justify-between gap-sm">
                <span className="font-title-md text-title-md text-on-surface">
                  {v.basis === "CASH" ? "Presupuesto de caja" : "Presupuesto de consumo"}
                </span>
                {/* El color acompaña, nunca comunica solo: el chip lleva texto. */}
                <Chip tono={TONO_ESTADO[v.state]}>{ETIQUETA_ESTADO[v.state]}</Chip>
              </div>
              <p className="font-body-md text-body-md text-on-surface-variant">{v.leyenda}</p>
              {v.budget !== null && (
                <DataRow label="Presupuesto del mes">
                  {/* También por `<Monto>`: el presupuesto es plata y no tiene
                      por qué pintarse con otro camino que el resto. */}
                  <Monto valor={dato(known(v.budget))} />
                </DataRow>
              )}
              <DataRow label="Holgura proyectada">
                <Monto valor={dato(v.headroom)} />
              </DataRow>
            </Card>
          ))}
        </div>
      </Section>

      {panel.faltantes.length > 0 && (
        <Section
          title="Lo que todavía no se puede costear"
          hint="Se declara: un desconocido escondido es peor que un descuadre a la vista"
        >
          <Card className="flex flex-col gap-xs px-md py-md">
            {panel.faltantes.map((x) => (
              <DataRow key={`${x.origen}-${x.motivo}`} label={etiquetaFaltante(x.origen, x.motivo)}>
                <span className="font-body-md text-body-md text-on-surface-variant">
                  {x.cuantos} {NOMBRE_ORIGEN[x.origen] ?? "movimientos"}
                </span>
              </DataRow>
            ))}
          </Card>
        </Section>
      )}
    </>
  );
}

const NOMBRE_FALTANTE: Record<string, string> = {
  NO_PRICE_RECORDED: "Nunca se registró un precio",
  LOT_VALUE_UNKNOWN: "Entraron a la despensa sin boleta",
  MIXED_UNKNOWN_MERGE: "Se juntaron con algo sin valor conocido",
  CONSUMPTION_WITHOUT_LOT: "Se consumieron sin lote de origen",
  NOT_YET_RECOGNIZED: "La boleta todavía no llega",
  UNIT_NOT_NORMALIZABLE: "No se pueden llevar a precio por kilo",
  POLICY_NOT_APPLICABLE: "No se pudo repartir el costo",
  SIN_MOTIVO_DECLARADO: "Sin motivo declarado",
};

const NOMBRE_ORIGEN: Record<string, string> = {
  LOTE: "lotes",
  ASIGNACION: "movimientos",
  CARGO: "cargos de compra",
};

/**
 * El despacho de una compra manual no se explica igual que un lote sin boleta.
 * Antes los dos caían en el mismo texto por compartir el motivo, y la persona
 * salía a buscar una boleta que sí existe.
 */
function etiquetaFaltante(origen: string, motivo: string): string {
  if (origen === "CARGO") return "Despacho y otros cargos que nunca entraron a los libros";
  return NOMBRE_FALTANTE[motivo] ?? motivo;
}
