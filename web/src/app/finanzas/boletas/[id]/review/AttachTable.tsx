"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { acknowledgeDuplicate, attachBlocks, attachReceipt, type ReceiptLink } from "../../actions";
import { Button, ButtonOutline, Card, Chip, EmptyState, ErrorNote, Icon, Notice } from "@/components/ui";
import { Monto } from "@/components/Monto";
import { money, type CurrencyCode } from "@/domain/finance/money";
import type { FilaBoleta } from "./ReviewTable";

/**
 * LA PANTALLA DEL DESTINO «YA LLEGÓ».
 *
 * La app venía ofreciendo este destino en dos lugares —el radio de la subida y
 * la invitación de la lista— y no había dónde terminarlo: `attach` no tenía ni
 * un llamador de producción y el botón de confirmar quedaba deshabilitado para
 * siempre. Quien seguía el consejo de la propia app terminaba cambiándole el
 * destino a «compra nueva», que es justo el camino que mete la mercadería dos
 * veces.
 *
 * Acá NO entra nada a la despensa: cada línea de la boleta se empareja con un
 * lote QUE YA ESTÁ GUARDADO y sin precio, y lo único que viaja es la plata.
 */
export interface LoteSinValor {
  id: string;
  label: string;
  quantity: number;
  unit: string;
}

const CAMPO =
  "w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-sm py-2 " +
  "font-body-sm text-body-sm min-h-[44px]";

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
  // ERROR != VACÍO: un motivo que la pantalla no conoce se muestra tal cual.
  return conocido === undefined ? clave : conocido;
}

interface EstadoEnlace {
  /** `""` = todavía sin elegir; `"DESCARTAR"` = esta línea no está guardada. */
  lote: string;
  abierta: boolean;
}

const SIN_ELEGIR = "";
const DESCARTAR = "DESCARTAR";

export function AttachTable({
  receiptId,
  currency,
  filas,
  lotes,
  totalExtraidoMinor,
  totalSource,
  duplicadoDe,
  duplicadoDeclarado,
}: {
  receiptId: string;
  currency: CurrencyCode;
  filas: FilaBoleta[];
  lotes: LoteSinValor[];
  totalExtraidoMinor: string | null;
  totalSource: string;
  duplicadoDe: string | null;
  duplicadoDeclarado: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [bloqueos, setBloqueos] = useState<string[]>([]);
  const [estados, setEstados] = useState<Record<string, EstadoEnlace>>({});
  const [motivoDuplicado, setMotivoDuplicado] = useState("");
  // [H42] El total lo escribe una persona mirando el papel, también acá: sin él,
  // el servidor exige abrir línea por línea.
  const [totalTecleado, setTotalTecleado] = useState("");

  const pendientes = useMemo(() => filas.filter((f) => f.status === "PENDING"), [filas]);

  function estadoDe(fila: FilaBoleta): EstadoEnlace {
    const guardado = estados[fila.id];
    if (guardado !== undefined) return guardado;
    return { lote: SIN_ELEGIR, abierta: false };
  }

  function cambiar(id: string, cambio: Partial<EstadoEnlace>) {
    setEstados((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? { lote: SIN_ELEGIR, abierta: false }), ...cambio },
    }));
  }

  /**
   * Sólo las líneas que YA tienen decisión viajan. Una línea sin elegir no se
   * manda como si estuviera descartada: el servidor la reclama por su nombre
   * («quedan N líneas sin decidir») y eso es exactamente lo que queremos que
   * lea la persona.
   */
  function enlacesDePantalla(): ReceiptLink[] {
    const salida: ReceiptLink[] = [];
    for (const fila of pendientes) {
      const e = estadoDe(fila);
      if (e.lote === SIN_ELEGIR) continue;
      salida.push({
        candidateId: fila.id,
        lotId: e.lote === DESCARTAR ? null : e.lote,
        acknowledged: e.abierta ? true : undefined,
      });
    }
    return salida;
  }

  const enlazadas = pendientes.filter((f) => {
    const e = estadoDe(f);
    return e.lote !== SIN_ELEGIR && e.lote !== DESCARTAR;
  }).length;
  const sinDecidir = pendientes.filter((f) => estadoDe(f).lote === SIN_ELEGIR).length;

  function revisar() {
    setError(null);
    setMensaje(null);
    startTransition(async () => {
      const r = await attachBlocks(receiptId, enlacesDePantalla(), totalTecleado);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      // `r.blocks` existe porque `r.ok` es true: la unión discriminada de
      // `BlocksResult` hace imposible leer una lista vacía cuando en realidad
      // el servidor no contestó.
      const encontrados = r.blocks;
      setBloqueos(encontrados);
      if (encontrados.length === 0) setMensaje("Todo cuadra. Ya puedes adjuntarla.");
    });
  }

  function adjuntar() {
    setError(null);
    setMensaje(null);
    startTransition(async () => {
      const r = await attachReceipt(receiptId, enlacesDePantalla(), totalTecleado);
      if (!r.ok) {
        setError(r.error ?? "No se pudo adjuntar.");
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
      <EmptyState icon="receipt_long">No quedan líneas por emparejar en esta boleta.</EmptyState>
    );
  }

  if (lotes.length === 0) {
    return (
      <EmptyState icon="inventory_2">
        No hay nada guardado esperando su precio: todos los lotes de la despensa ya saben lo que
        costaron. Si esta compra todavía no entró, cambia el destino de la boleta a «compra nueva».
      </EmptyState>
    );
  }

  return (
    <section className="space-y-md">
      <Notice icon="link" tono="info">
        Esta boleta llegó <strong>después</strong> de la mercadería: acá no entra nada nuevo a la
        despensa. Cada línea se empareja con un lote que ya está guardado y sólo se le pone el
        precio que faltaba.
      </Notice>

      {duplicadoDe !== null && !duplicadoDeclarado && (
        <Card className="space-y-sm p-md">
          <Notice icon="content_copy">
            Hay otra boleta del mismo comercio, la misma fecha y el mismo total. Si de verdad son
            dos compras distintas, dilo acá y sigue. Si es la misma, archiva esta.
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

      <Card className="space-y-sm p-md">
        <h3 className="font-headline-sm text-headline-sm text-on-surface">
          El total que dice el papel
        </h3>
        <p className="font-body-sm text-body-sm text-on-surface-variant">
          Míralo en la boleta y escríbelo. Si lo dejas vacío, cada línea hay que abrirla y revisarla
          una por una antes de poder adjuntarla.
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
      </Card>

      {pendientes.map((fila) => {
        const e = estadoDe(fila);
        const marcada = fila.doubtReasons.length > 0;
        const descartada = e.lote === DESCARTAR;
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
                  {fila.quantity !== null && fila.unit !== null
                    ? `${fila.quantity} ${fila.unit} según el papel`
                    : "el papel no trae cantidad legible"}
                </p>
              </div>
              <div className="shrink-0">
                {descartada ? (
                  <Chip icon="delete">no está guardada</Chip>
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

            {marcada && (
              <ul className="mt-sm space-y-1 rounded-xl bg-secondary-fixed px-md py-sm">
                {fila.doubtReasons.map((m) => (
                  <li key={m} className="font-body-sm text-body-sm text-on-secondary-fixed-variant">
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
                <p className="font-body-sm text-body-sm text-on-surface-variant">
                  cantidad {fila.quantity ?? "—"} {fila.unit ?? ""} · precio{" "}
                  {fila.unitPriceMinor ?? "—"} · total {fila.lineTotalMinor ?? "—"}
                  {fila.barcode !== null &&
                    ` · código ${fila.barcode}${fila.barcodeCheckOk === true ? "" : " (no valida)"}`}
                </p>
                <p className="font-body-sm text-body-sm text-on-surface-variant">
                  Adjuntar no corrige números: si el papel dice otra cosa, esta línea no
                  corresponde a este lote. La cantidad la manda el lote, siempre.
                </p>
              </div>
            )}

            <label className="mt-md block">
              <span className="mb-1 block font-label-md text-label-md text-on-surface-variant">
                ¿A qué lote guardado le corresponde este precio?
              </span>
              <select
                value={e.lote}
                onChange={(ev) => cambiar(fila.id, { lote: ev.target.value })}
                className={CAMPO}
              >
                <option value={SIN_ELEGIR}>— elige el lote —</option>
                {lotes.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label} · {l.quantity} {l.unit}
                  </option>
                ))}
                <option value={DESCARTAR}>
                  esta línea no está guardada: descartarla
                </option>
              </select>
            </label>

            <div className="mt-md flex flex-wrap gap-sm">
              <ButtonOutline
                disabled={pending}
                onClick={() => cambiar(fila.id, { abierta: !e.abierta })}
              >
                {e.abierta ? "Cerrar" : "Abrir y revisar"}
              </ButtonOutline>
            </div>
          </Card>
        );
      })}

      {bloqueos.length > 0 && (
        <Card className="space-y-sm p-md">
          <h3 className="font-headline-sm text-headline-sm text-on-surface">
            Falta esto antes de adjuntar
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
          {enlazadas} línea(s) le pondrán precio a un lote guardado
          {sinDecidir > 0 ? ` · quedan ${sinDecidir} sin decidir` : ""}. No se crea ningún lote
          nuevo.
        </p>
        <ButtonOutline disabled={pending} onClick={revisar}>
          Revisar antes de adjuntar
        </ButtonOutline>
        <Button disabled={pending} onClick={adjuntar} full>
          {pending ? "Adjuntando…" : "Ponerle precio a lo que ya está guardado"}
        </Button>
      </div>
    </section>
  );
}
