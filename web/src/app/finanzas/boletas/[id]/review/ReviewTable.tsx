"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  acknowledgeDuplicate,
  confirmReceipt,
  receiptBlocks,
  type ReceiptCharge,
  type ReceiptDecision,
} from "../../actions";
import { Button, ButtonOutline, Card, Chip, EmptyState, ErrorNote, Icon, Notice } from "@/components/ui";
import { Monto } from "@/components/Monto";
import { money, type CurrencyCode } from "@/domain/finance/money";

export interface FilaBoleta {
  id: string;
  lineOrdinal: number;
  rawLineText: string;
  snippet: string | null;
  quantity: number | null;
  unit: string | null;
  /** Los montos llegan como TEXTO en unidades menores. Nunca como `number`. */
  unitPriceMinor: string | null;
  unitPriceBasis: string | null;
  lineTotalMinor: string | null;
  discountMinor: string | null;
  barcode: string | null;
  barcodeCheckOk: boolean | null;
  matchMethod: string;
  matchScore: number | null;
  doubtReasons: string[];
  status: string;
  etiqueta: string | null;
}

const CAMPO =
  "w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-sm py-2 " +
  "font-body-sm text-body-sm min-h-[44px]";

/**
 * Por qué esta línea está marcada, en palabras y señalando el campo.
 *
 * Las etiquetas las calcula el SERVIDOR (`app.receipt_candidate_doubts`); acá
 * solo se traducen. Si la pantalla decidiera por su cuenta cuál línea es
 * dudosa, habría dos definiciones de lo mismo y la que manda —la del servidor—
 * rechazaría cosas que el botón dejó apretar.
 */
const MOTIVOS: Readonly<Record<string, string>> = {
  SIN_PRODUCTO: "no dice qué alimento es",
  SIN_TOTAL_DE_LINEA: "sin total de línea: no se sabe cuánto costó",
  MATCH_DUDOSO: "no estamos seguros de qué producto es",
  BARRAS_INVALIDO: "el código de barras no cuadra: puede estar mal leído",
  BARRAS_SIN_RESPALDO: "se matcheó por código de barras y el código no valida",
  ARITMETICA_NO_CUADRA: "precio × cantidad no da el total impreso",
  PRECIO_SIN_BASE: "no dice si el precio es por kilo, por litro o por unidad",
  PRECIO_FUERA_DE_RANGO: "el precio se movió mucho respecto de la última vez acá",
  "LECTURA_DUDOSA:quantity": "la cantidad se leyó borrosa",
  "LECTURA_DUDOSA:unit_price": "el precio unitario se leyó borroso",
  "LECTURA_DUDOSA:line_total": "el total de la línea se leyó borroso",
  "LECTURA_DUDOSA:barcode": "el código de barras se leyó borroso",
  "LECTURA_DUDOSA:linea": "la línea entera se leyó borrosa",
};

function describirMotivo(clave: string): string {
  const conocido = MOTIVOS[clave];
  // ERROR != VACÍO también acá: un motivo que la pantalla no conoce se muestra
  // tal cual en vez de desaparecer. Una línea marcada sin explicación visible es
  // una línea que la persona confirma sin saber qué revisar.
  return conocido === undefined ? clave : conocido;
}

const TIPOS_CARGO = [
  { kind: "DELIVERY", label: "Despacho", policy: "EXPENSE_ONLY" as const },
  { kind: "BAG", label: "Bolsas", policy: "EXPENSE_ONLY" as const },
  { kind: "SERVICE_FEE", label: "Comisión de servicio", policy: "EXPENSE_ONLY" as const },
  { kind: "ORDER_DISCOUNT", label: "Descuento de la boleta", policy: "PRO_RATA_VALUE" as const },
  { kind: "COUPON", label: "Cupón", policy: "PRO_RATA_VALUE" as const },
];

interface EstadoFila {
  accion: "CONFIRM" | "DISCARD";
  abierta: boolean;
  totalTexto: string | null;
}

interface CargoEditable {
  id: number;
  tipo: number;
  montoTexto: string;
}

/** Solo dígitos y un signo: los montos NUNCA pasan por `Number`. */
function minorLimpio(bruto: string): string | null {
  const limpio = bruto.trim().replace(/\./g, "");
  if (limpio === "") return null;
  return /^-?\d+$/.test(limpio) ? limpio : null;
}

export function ReviewTable({
  receiptId,
  currency,
  filas,
  totalExtraidoMinor,
  totalSource,
  fechaImpresa,
  duplicadoDe,
  duplicadoDeclarado,
}: {
  receiptId: string;
  currency: CurrencyCode;
  filas: FilaBoleta[];
  totalExtraidoMinor: string | null;
  totalSource: string;
  fechaImpresa: string | null;
  duplicadoDe: string | null;
  duplicadoDeclarado: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [bloqueos, setBloqueos] = useState<string[]>([]);
  const [estados, setEstados] = useState<Record<string, EstadoFila>>({});
  const [cargos, setCargos] = useState<CargoEditable[]>([]);
  const [siguienteCargo, setSiguienteCargo] = useState(1);
  const [motivoDuplicado, setMotivoDuplicado] = useState("");
  const [fechaTecleada, setFechaTecleada] = useState("");
  // [H42] El total NO viene precargado desde el OCR a propósito: el ancla contra
  // la que se concilia todo lo demás la escribe una persona mirando el papel.
  // Precargarlo convertiría "confirmar" en apretar un botón sobre un número que
  // nadie leyó, y un total mal leído puede TAPAR una línea mal leída.
  const [totalTecleado, setTotalTecleado] = useState("");

  const pendientes = useMemo(() => filas.filter((f) => f.status === "PENDING"), [filas]);

  function estadoDe(fila: FilaBoleta): EstadoFila {
    const guardado = estados[fila.id];
    if (guardado !== undefined) return guardado;
    return { accion: "CONFIRM", abierta: false, totalTexto: null };
  }

  function cambiar(id: string, cambio: Partial<EstadoFila>) {
    setEstados((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? { accion: "CONFIRM", abierta: false, totalTexto: null }), ...cambio },
    }));
  }

  function decisionDe(fila: FilaBoleta): ReceiptDecision {
    const e = estadoDe(fila);
    if (e.accion === "DISCARD") return { candidateId: fila.id, action: "DISCARD" };
    const base: ReceiptDecision = {
      candidateId: fila.id,
      // [H45] `acknowledged` significa haber ABIERTO la línea. El servidor lo
      // exige para toda línea marcada: "confirmar todas" con 40 líneas de súper
      // es exactamente donde el dígito mal leído se confirma solo.
      action: e.totalTexto === null ? "CONFIRM" : "EDIT",
      acknowledged: e.abierta ? true : undefined,
    };
    if (e.totalTexto !== null) {
      base.lineTotalMinor = minorLimpio(e.totalTexto);
    }
    return base;
  }

  function cargosDePantalla(): ReceiptCharge[] {
    const salida: ReceiptCharge[] = [];
    for (const c of cargos) {
      const tipo = TIPOS_CARGO[c.tipo];
      const monto = minorLimpio(c.montoTexto);
      if (tipo === undefined || monto === null) continue;
      salida.push({ kind: tipo.kind, label: tipo.label, amountMinor: monto, policy: tipo.policy });
    }
    return salida;
  }

  function totalDePantalla(): string | null {
    return minorLimpio(totalTecleado);
  }

  function revisar() {
    setError(null);
    setMensaje(null);
    startTransition(async () => {
      const r = await receiptBlocks(
        receiptId,
        pendientes.map(decisionDe),
        totalDePantalla(),
        cargosDePantalla(),
      );
      if (!r.ok) {
        setError(r.error);
        return;
      }
      // `r.blocks` existe porque `r.ok` es true: la unión discriminada de
      // `BlocksResult` hace imposible leer una lista vacía cuando en realidad
      // el servidor no contestó.
      const encontrados = r.blocks;
      setBloqueos(encontrados);
      if (encontrados.length === 0) {
        setMensaje("Todo cuadra. Ya puedes confirmar.");
      }
    });
  }

  function confirmar() {
    setError(null);
    setMensaje(null);
    startTransition(async () => {
      const r = await confirmReceipt(
        receiptId,
        pendientes.map(decisionDe),
        totalTecleado,
        cargosDePantalla(),
        fechaTecleada === "" ? null : fechaTecleada,
      );
      if (!r.ok) {
        setError(r.error ?? "No se pudo confirmar.");
        return;
      }
      setMensaje(r.message ?? "Listo.");
      setBloqueos([]);
      router.refresh();
    });
  }

  function declararDuplicado() {
    setError(null);
    startTransition(async () => {
      const r = await acknowledgeDuplicate(receiptId, motivoDuplicado);
      if (!r.ok) {
        setError(r.error ?? "No se pudo declarar.");
        return;
      }
      setMensaje(r.message ?? "Anotado.");
      router.refresh();
    });
  }

  if (pendientes.length === 0) {
    return (
      <EmptyState icon="receipt_long">
        No quedan líneas por revisar en esta boleta.
      </EmptyState>
    );
  }

  const confirmables = pendientes.filter((f) => estadoDe(f).accion === "CONFIRM");

  return (
    <section className="space-y-md">
      {duplicadoDe !== null && !duplicadoDeclarado && (
        <Card className="space-y-sm p-md">
          <Notice icon="content_copy">
            Hay otra boleta del mismo comercio, la misma fecha y el mismo total. Si de verdad son
            dos compras distintas —volvieron al súper en la tarde, por ejemplo— dilo acá y sigue.
            Si es la misma, archiva esta.
          </Notice>
          <label className="block">
            <span className="mb-1 block font-label-md text-label-md text-on-surface-variant">
              ¿Por qué son dos compras distintas?
            </span>
            <input
              type="text"
              value={motivoDuplicado}
              onChange={(ev) => setMotivoDuplicado(ev.target.value)}
              placeholder="volvimos en la tarde por lo que faltaba"
              className={CAMPO}
            />
          </label>
          <Button disabled={pending || motivoDuplicado.trim() === ""} onClick={declararDuplicado}>
            Son dos compras distintas
          </Button>
        </Card>
      )}

      {/* [H42] El total, grande y en manos de una persona. */}
      <Card className="space-y-sm p-md">
        <h3 className="font-headline-sm text-headline-sm text-on-surface">
          El total que dice el papel
        </h3>
        <p className="font-body-sm text-body-sm text-on-surface-variant">
          Míralo en la boleta y escríbelo. Es el único número contra el que se puede verificar todo
          lo demás; si lo dejas vacío, cada línea hay que abrirla y revisarla una por una.
        </p>
        <input
          type="text"
          inputMode="numeric"
          value={totalTecleado}
          onChange={(ev) => setTotalTecleado(ev.target.value)}
          placeholder="25990"
          aria-label="Total impreso en la boleta"
          className={`${CAMPO} font-headline-sm text-headline-sm min-h-[56px]`}
        />
        <p className="font-body-sm text-body-sm text-on-surface-variant">
          {totalExtraidoMinor === null
            ? "La lectura automática no logró leer el total de esta boleta."
            : `La lectura automática leyó ${totalExtraidoMinor} (${
                totalSource === "PRINTED" ? "del papel" : "sumando las líneas"
              }). Compáralo con lo que ves.`}
        </p>
        {fechaImpresa === null && (
          <label className="block">
            <span className="mb-1 block font-label-md text-label-md text-on-surface-variant">
              Fecha de la compra (la boleta no la traía legible)
            </span>
            <input
              type="date"
              value={fechaTecleada}
              onChange={(ev) => setFechaTecleada(ev.target.value)}
              className={CAMPO}
            />
          </label>
        )}
      </Card>

      {pendientes.map((fila) => {
        const e = estadoDe(fila);
        const descartada = e.accion === "DISCARD";
        const marcada = fila.doubtReasons.length > 0;
        return (
          <Card
            key={fila.id}
            as="article"
            className={`p-md ${descartada ? "opacity-50" : marcada ? "ring-1 ring-secondary-fixed-dim" : ""}`}
          >
            <div className="mb-sm flex flex-wrap items-start justify-between gap-sm">
              <div className="min-w-0">
                <p className="font-body-md text-body-md font-semibold text-on-surface">
                  {fila.rawLineText}
                </p>
                <p className="font-body-sm text-body-sm text-on-surface-variant">
                  {fila.etiqueta === null ? "sin alimento asignado" : fila.etiqueta}
                  {fila.quantity !== null && fila.unit !== null
                    ? ` · ${fila.quantity} ${fila.unit}`
                    : ""}
                </p>
              </div>
              <div className="shrink-0">
                {descartada ? (
                  <Chip icon="delete">descartada</Chip>
                ) : marcada ? (
                  <Chip tono="atencion" icon="priority_high">
                    revisar
                  </Chip>
                ) : (
                  <Chip tono="primario" icon="check">
                    limpia
                  </Chip>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-end justify-between gap-md">
              <Monto
                valor={
                  fila.lineTotalMinor === null
                    ? { estado: "DATO", valor: { known: false, reason: "NO_PRICE_RECORDED" } }
                    : {
                        estado: "DATO",
                        valor: { known: true, amount: money(currency, BigInt(fila.lineTotalMinor)) },
                      }
                }
              />
              {fila.unitPriceMinor !== null && (
                <span className="font-body-sm text-body-sm text-on-surface-variant">
                  precio impreso {fila.unitPriceMinor}
                  {fila.unitPriceBasis === null ? " (sin base declarada)" : ` ${fila.unitPriceBasis}`}
                </span>
              )}
            </div>

            {marcada && (
              <ul className="mt-sm space-y-1 rounded-xl bg-secondary-fixed px-md py-sm">
                {fila.doubtReasons.map((m) => (
                  <li
                    key={m}
                    className="font-body-sm text-body-sm text-on-secondary-fixed-variant"
                  >
                    {describirMotivo(m)}
                  </li>
                ))}
              </ul>
            )}

            {e.abierta && (
              <div className="mt-sm space-y-sm rounded-xl bg-surface-container px-md py-sm">
                {fila.snippet !== null && (
                  <p className="font-body-sm text-body-sm text-on-surface-variant">
                    <Icon name="format_quote" className="mr-1 align-middle text-[16px]" />
                    {fila.snippet}
                  </p>
                )}
                {/* Los tres números son datos LEÍDOS y el sistema no sabe cuál
                    está malo: se muestran los tres y corrige la persona. */}
                <p className="font-body-sm text-body-sm text-on-surface-variant">
                  cantidad {fila.quantity ?? "—"} {fila.unit ?? ""} · precio{" "}
                  {fila.unitPriceMinor ?? "—"} · total {fila.lineTotalMinor ?? "—"}
                  {fila.barcode !== null &&
                    ` · código ${fila.barcode}${fila.barcodeCheckOk === true ? "" : " (no valida)"}`}
                </p>
                <label className="block">
                  <span className="mb-1 block font-label-md text-label-md text-on-surface-variant">
                    Corrige el total de esta línea si el papel dice otra cosa
                  </span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={e.totalTexto ?? ""}
                    onChange={(ev) =>
                      cambiar(fila.id, {
                        totalTexto: ev.target.value === "" ? null : ev.target.value,
                      })
                    }
                    placeholder={fila.lineTotalMinor ?? "sin total"}
                    className={CAMPO}
                  />
                </label>
              </div>
            )}

            <div className="mt-md flex flex-wrap gap-sm">
              <ButtonOutline
                disabled={pending}
                onClick={() => cambiar(fila.id, { abierta: !e.abierta })}
              >
                {e.abierta ? "Cerrar" : "Abrir y revisar"}
              </ButtonOutline>
              <ButtonOutline
                disabled={pending}
                onClick={() =>
                  cambiar(fila.id, { accion: descartada ? "CONFIRM" : "DISCARD" })
                }
              >
                {descartada ? "Recuperar" : "Descartar"}
              </ButtonOutline>
            </div>
          </Card>
        );
      })}

      <Card className="space-y-sm p-md">
        <h3 className="font-headline-sm text-headline-sm text-on-surface">
          Despacho, bolsas y descuentos
        </h3>
        <p className="font-body-sm text-body-sm text-on-surface-variant">
          Van como cargos con nombre y monto, no escondidos dentro de una línea. El despacho y las
          bolsas <strong>no</strong> se capitalizan: son gasto de la casa, no valor de la despensa —
          cargárselos al pollo dejaría el kilo de pollo caro para siempre.
        </p>
        {cargos.map((c) => (
          <div key={c.id} className="flex flex-wrap items-end gap-sm">
            <label className="min-w-[10rem] flex-1">
              <span className="mb-1 block font-label-md text-label-md text-on-surface-variant">
                Tipo
              </span>
              <select
                value={c.tipo}
                onChange={(ev) =>
                  setCargos((prev) =>
                    prev.map((x) =>
                      x.id === c.id ? { ...x, tipo: Number(ev.target.value) } : x,
                    ),
                  )
                }
                className={CAMPO}
              >
                {TIPOS_CARGO.map((t, i) => (
                  <option key={t.kind} value={i}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="min-w-[8rem] flex-1">
              <span className="mb-1 block font-label-md text-label-md text-on-surface-variant">
                Monto (negativo si rebaja)
              </span>
              <input
                type="text"
                inputMode="numeric"
                value={c.montoTexto}
                onChange={(ev) =>
                  setCargos((prev) =>
                    prev.map((x) => (x.id === c.id ? { ...x, montoTexto: ev.target.value } : x)),
                  )
                }
                className={CAMPO}
              />
            </label>
            <ButtonOutline
              disabled={pending}
              onClick={() => setCargos((prev) => prev.filter((x) => x.id !== c.id))}
            >
              Quitar
            </ButtonOutline>
          </div>
        ))}
        <ButtonOutline
          disabled={pending}
          onClick={() => {
            setCargos((prev) => [...prev, { id: siguienteCargo, tipo: 0, montoTexto: "" }]);
            setSiguienteCargo((n) => n + 1);
          }}
        >
          Agregar cargo
        </ButtonOutline>
      </Card>

      {bloqueos.length > 0 && (
        <Card className="space-y-sm p-md">
          <h3 className="font-headline-sm text-headline-sm text-on-surface">
            Falta esto antes de confirmar
          </h3>
          <ul className="space-y-1">
            {bloqueos.map((b) => (
              <li key={b} className="font-body-sm text-body-sm text-on-surface-variant">
                {b}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {error !== null && <ErrorNote>{error}</ErrorNote>}
      {mensaje !== null && (
        <p className="rounded-xl bg-primary-fixed px-md py-sm font-body-sm text-body-sm text-on-primary-fixed">
          {mensaje}
        </p>
      )}

      <div className="space-y-sm">
        <p className="font-body-sm text-body-sm text-on-surface-variant">
          Al confirmar entran {confirmables.length} línea(s) a la despensa con su valor
          {pendientes.length - confirmables.length > 0
            ? ` y se descartan ${pendientes.length - confirmables.length}`
            : ""}
          .
        </p>
        <ButtonOutline disabled={pending} onClick={revisar}>
          Revisar antes de confirmar
        </ButtonOutline>
        <Button disabled={pending} onClick={confirmar} full>
          {pending ? "Confirmando…" : "Confirmar la boleta"}
        </Button>
      </div>
    </section>
  );
}
