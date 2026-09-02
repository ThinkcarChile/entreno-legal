"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatDate } from "@/domain/nutrition/calendar";
import { stockKey } from "@/domain/inventory/fefo";
import {
  formatQuantity,
  groupForCategory,
  SHOPPING_GROUPS,
  type DemandDelta,
} from "@/domain/shopping/engine";
import { MEAL_TYPE_LABELS, type MealType } from "@/domain/recipes/types";
import { Button, ButtonOutline, Card, Chip, Flotante, Icon, Notice } from "@/components/ui";
import type { ShoppingItem, ShoppingListData } from "./queries";
import { textoDelRelevo, type RelevoDeEvento } from "@/app/demanda-abierta";
import {
  addManualItem,
  completeList,
  editPlannedQuantity,
  previewDeltas,
  regenerateList,
  removeManualItem,
  reopenList,
  setItemStatus,
} from "./actions";
import { receiveShoppingList } from "@/app/pantry/actions";

/**
 * El checklist de la compra. Cada línea sabe explicar de dónde salió (§16, §17)
 * y nada se actualiza en silencio: si la planificación cambió, primero se
 * muestran los deltas y la persona decide (§34).
 */

const STATUS_LABELS: Record<ShoppingItem["status"], string> = {
  PENDING: "Pendiente",
  PURCHASED: "Comprado",
  SKIPPED: "No lo llevo",
  HAVE_ENOUGH: "Ya lo tengo",
};

/** Un icono por pasillo: ayuda a ubicarse en el súper de un vistazo. */
const GROUP_ICONS: Record<string, string> = {
  FRESH: "nutrition",
  MEAT: "set_meal",
  FISH: "phishing",
  DAIRY: "water_drop",
  BAKERY: "bakery_dining",
  PANTRY: "inventory_2",
  FROZEN: "ac_unit",
  CONDIMENTS: "spa",
  OTHER: "category",
};

/** Campo de formulario del kit: mismo alto de toque en todos lados. */
const FIELD =
  "w-full rounded-xl border border-outline-variant bg-surface-container-lowest px-md py-sm font-body-md text-body-md text-on-surface";


export function ShoppingBoard({
  weekStart,
  lista,
  unconfirmed,
  relevos,
  desactualizada,
  demandaDisponible,
  stock = {},
}: {
  weekStart: string;
  lista: ShoppingListData | null;
  unconfirmed: { date: string; mealType: MealType; recipeName: string | null }[];
  /**
   * Las comidas de esta semana que un evento releva: NO se compran, y la
   * pantalla lo dice. Una lista que encoge sin explicación se lee como una
   * falla del sistema y termina con alguien comprando el almuerzo igual.
   */
  relevos: RelevoDeEvento[];
  desactualizada: boolean;
  demandaDisponible: boolean;
  /** Stock disponible por `ingredientId::unidad::base` (Sprint 7). */
  stock?: Record<string, { quantity: number; lots: number }>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [abierto, setAbierto] = useState<string | null>(null);
  const [deltas, setDeltas] = useState<DemandDelta[] | null>(null);
  const [manualAbierto, setManualAbierto] = useState(false);

  function run(action: () => Promise<{ ok: boolean; error?: string; message?: string }>) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error ?? "No se pudo completar.");
        return;
      }
      if (result.message) setMessage(result.message);
      setDeltas(null);
      router.refresh();
    });
  }

  const items = lista?.items ?? [];
  const resueltos = items.filter((i) => i.status !== "PENDING").length;
  const completada = lista?.status === "COMPLETED";

  // Secciones por categoría del catálogo (§18). Manuales sin categoría → Otros.
  const porGrupo = new Map<string, ShoppingItem[]>();
  for (const item of items) {
    const grupo = groupForCategory(item.categoryCode);
    porGrupo.set(grupo, [...(porGrupo.get(grupo) ?? []), item]);
  }

  return (
    <div className="mt-md space-y-md">
      {message && <Flotante tono="ok">{message}</Flotante>}
      {error && <Flotante tono="error">{error}</Flotante>}

      {relevos.length > 0 && (
        <Notice icon="outdoor_grill" tono="info">
          <p className="font-semibold">
            {relevos.length === 1
              ? "Hay 1 comida que esta semana no se compra"
              : `Hay ${relevos.length} comidas que esta semana no se compran`}
          </p>
          <p className="mt-0.5">
            Un evento las reemplaza, así que sus ingredientes NO están en esta lista. Lo del
            evento se compra en su propia pantalla.
          </p>
          <ul className="mt-sm list-inside list-disc">
            {relevos.map((r) => (
              <li key={`${r.eventoId}-${r.fecha}-${r.comidaCruda}`} className="min-w-0">
                {textoDelRelevo(r)}{" "}
                <Link
                  href={`/eventos/${r.eventoId}`}
                  className="font-semibold underline underline-offset-2"
                >
                  Ver el evento
                </Link>
              </li>
            ))}
          </ul>
        </Notice>
      )}

      {unconfirmed.length > 0 && (
        <Notice icon="pending_actions">
          <p className="font-semibold">
            {unconfirmed.length === 1
              ? "Falta 1 comida por confirmar"
              : `Faltan ${unconfirmed.length} comidas por confirmar`}
          </p>
          <p className="mt-0.5">
            La lista incluye solo lo confirmado; confirma el resto para completar la compra.
          </p>
          <ul className="mt-sm list-inside list-disc">
            {unconfirmed.slice(0, 4).map((u, i) => (
              <li key={i}>
                {formatDate(u.date)} · {MEAL_TYPE_LABELS[u.mealType]}
                {u.recipeName && <> · {u.recipeName}</>}
              </li>
            ))}
            {unconfirmed.length > 4 && <li>y {unconfirmed.length - 4} más…</li>}
          </ul>
          <Link
            href={`/plan?semana=${weekStart}`}
            className="mt-sm inline-block font-semibold underline underline-offset-2"
          >
            Ir a la semana
          </Link>
        </Notice>
      )}

      {desactualizada && !completada && (
        <Card className="p-md">
          <p className="flex items-center gap-sm font-body-md text-body-md font-semibold text-on-surface">
            <Icon name="update" className="shrink-0 text-secondary" />
            Tu planificación cambió.
          </p>
          {deltas === null ? (
            <div className="mt-sm">
              <ButtonOutline
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const r = await previewDeltas(weekStart);
                    if (!r.ok) {
                      setError(r.error ?? "No se pudieron calcular los cambios.");
                      return;
                    }
                    setDeltas(r.deltas ?? []);
                  })
                }
              >
                Revisar cambios
              </ButtonOutline>
            </div>
          ) : (
            <div className="mt-sm space-y-sm">
              {deltas.length === 0 ? (
                <p className="font-body-sm text-body-sm text-on-surface-variant">
                  Las cantidades finales no cambian.
                </p>
              ) : (
                <ul className="space-y-1">
                  {deltas.map((d) => (
                    <li
                      key={d.key}
                      className="flex justify-between gap-sm font-body-sm text-body-sm"
                    >
                      <span className="min-w-0 truncate text-on-surface">{d.label}</span>
                      <span
                        className={`shrink-0 ${
                          d.kind === "REMOVED" || d.kind === "QUANTITY_DECREASED"
                            ? "text-on-surface-variant"
                            : "font-semibold text-primary"
                        }`}
                      >
                        {d.kind === "ADDED" &&
                          (d.unresolved
                            ? "+ cantidad por confirmar (nuevo)"
                            : `+${formatQuantity(d.after ?? 0, d.unit)} (nuevo)`)}
                        {d.kind === "REMOVED" && `−${formatQuantity(d.before ?? 0, d.unit)} (sale)`}
                        {(d.kind === "QUANTITY_INCREASED" || d.kind === "QUANTITY_DECREASED") &&
                          `${d.difference > 0 ? "+" : "−"}${formatQuantity(Math.abs(d.difference), d.unit)}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap gap-sm">
                <Button
                  className="flex-1"
                  disabled={pending}
                  onClick={() => run(() => regenerateList(weekStart))}
                >
                  Actualizar lista
                </Button>
                <ButtonOutline className="flex-1" onClick={() => setDeltas(null)}>
                  Mantener lista actual
                </ButtonOutline>
              </div>
            </div>
          )}
        </Card>
      )}

      {(!lista || lista.currentRevision === 0) && (
        <Card className="flex flex-col items-center gap-md px-md py-lg text-center">
          {demandaDisponible ? (
            <>
              <Icon name="receipt_long" className="text-[32px] text-outline" />
              <p className="font-body-sm text-body-sm text-on-surface-variant">
                Hay comidas confirmadas esta semana. Genera la lista para saber exactamente qué
                comprar.
              </p>
              <Button disabled={pending} onClick={() => run(() => regenerateList(weekStart))}>
                <Icon name="auto_awesome" className="text-[18px]" />
                Generar lista de compras
              </Button>
            </>
          ) : (
            <>
              <Icon name="event_busy" className="text-[32px] text-outline" />
              <p className="font-body-sm text-body-sm text-on-surface-variant">
                Todavía no hay comidas confirmadas esta semana. Confirma porciones en la pestaña
                Semana y la lista se arma sola desde ahí.
              </p>
            </>
          )}
        </Card>
      )}

      {lista && lista.currentRevision > 0 && (
        <>
          <Card className="p-md">
            <div className="flex flex-wrap items-center justify-between gap-x-md gap-y-1">
              <span className="font-label-md text-label-md uppercase text-on-surface-variant">
                Progreso de compra
              </span>
              <span className="font-body-md text-body-md font-bold text-primary">
                {resueltos} / {items.length}
              </span>
            </div>
            <div
              className="mt-sm h-3 w-full overflow-hidden rounded-full bg-surface-container-highest"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={items.length}
              aria-valuenow={resueltos}
              aria-label="Productos resueltos"
            >
              <div
                className="h-full rounded-full bg-primary transition-all duration-500"
                style={{
                  width: items.length === 0 ? "0%" : `${(resueltos / items.length) * 100}%`,
                }}
              />
            </div>
            <div className="mt-sm flex flex-wrap items-center justify-between gap-sm">
              <span className="font-body-sm text-body-sm text-on-surface-variant">
                revisión {lista.currentRevision}
              </span>
              {completada && (
                <Chip tono="primario" icon="check_circle">
                  compra finalizada
                </Chip>
              )}
            </div>
          </Card>

          {SHOPPING_GROUPS.filter((g) => porGrupo.has(g.code)).map((grupo) => {
            const propios = porGrupo.get(grupo.code)!;
            return (
              <Card as="section" key={grupo.code} className="overflow-hidden">
                <div className="flex items-center gap-sm p-md">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-container text-primary">
                    <Icon name={GROUP_ICONS[grupo.code] ?? "category"} filled />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate font-headline-sm text-headline-sm text-on-surface">
                      {grupo.name}
                    </h3>
                    <p className="font-label-md text-label-md text-outline">
                      {propios.length} {propios.length === 1 ? "producto" : "productos"}
                    </p>
                  </div>
                </div>
                <ul className="space-y-sm px-md pb-md">
                  {propios.map((item) => (
                    <ItemRow
                      key={item.id}
                      item={item}
                      enDespensa={
                        item.ingredientId
                          ? (stock[
                              // La misma base con que receive_shopping_list crea el
                              // lote: DRAINED se recibe DRAINED, el resto RAW.
                              stockKey(
                                item.ingredientId,
                                item.unit,
                                item.purchaseBasis === "DRAINED" ? "DRAINED" : "RAW",
                              )
                            ] ?? null)
                          : null
                      }
                      abierto={abierto === item.id}
                      onToggle={() => setAbierto(abierto === item.id ? null : item.id)}
                      pending={pending || completada}
                      run={run}
                    />
                  ))}
                </ul>
              </Card>
            );
          })}

          {!completada && (
            <Card className="p-md">
              {!manualAbierto ? (
                <button
                  type="button"
                  onClick={() => setManualAbierto(true)}
                  className="flex w-full items-center justify-center gap-sm rounded-2xl border border-dashed border-outline px-lg py-md font-body-md text-body-md font-semibold text-primary transition-transform active:scale-[0.99]"
                >
                  <Icon name="add" className="text-[20px]" />
                  Agregar producto
                </button>
              ) : (
                <ManualForm
                  listId={lista.id}
                  pending={pending}
                  onSave={run}
                  onCancel={() => setManualAbierto(false)}
                />
              )}
            </Card>
          )}

          {completada ? (
            <div className="space-y-sm">
              <Button
                full
                disabled={pending}
                onClick={() => run(() => receiveShoppingList(lista.id))}
              >
                <Icon name="inventory_2" className="text-[18px]" />
                Recibir compra en la despensa
              </Button>
              <ButtonOutline
                className="w-full py-3"
                disabled={pending}
                onClick={() => run(() => reopenList(lista.id))}
              >
                Reabrir compra
              </ButtonOutline>
            </div>
          ) : (
            <Button full disabled={pending} onClick={() => run(() => completeList(lista.id))}>
              <Icon name="check_circle" className="text-[18px]" />
              Finalizar compra
            </Button>
          )}
        </>
      )}
    </div>
  );
}

function ItemRow({
  item,
  enDespensa,
  abierto,
  onToggle,
  pending,
  run,
}: {
  item: ShoppingItem;
  enDespensa: { quantity: number; lots: number } | null;
  abierto: boolean;
  onToggle: () => void;
  pending: boolean;
  run: (a: () => Promise<{ ok: boolean; error?: string; message?: string }>) => void;
}) {
  const [editando, setEditando] = useState(false);
  const [cantidad, setCantidad] = useState("");

  const necesario = item.requiredQuantity;
  const comprar = item.plannedQuantity ?? item.requiredQuantity;
  const resuelto = item.status !== "PENDING";
  // Gate 0→10 [J-2]: sin rendimiento cocido→crudo el motor NO sabe cuánto hace
  // falta, y dejaba la línea en 0. La pantalla mostraba «0 g», «Necesario: 0 g»
  // y —lo peor— «alcanzaría sin comprar». Cantidad desconocida se dice, no se
  // imprime como cero. Si una persona escribió una cantidad a mano, esa manda.
  const cantidadIncierta = item.unresolved && item.plannedQuantity === null;

  return (
    <li className="rounded-2xl bg-surface-container-low">
      <div className="flex items-center gap-md px-md py-sm">
        <input
          type="checkbox"
          className="size-6 shrink-0 accent-primary"
          checked={item.status === "PURCHASED"}
          disabled={pending}
          onChange={(e) =>
            run(() => setItemStatus(item.id, e.target.checked ? "PURCHASED" : "PENDING"))
          }
          aria-label={`Marcar ${item.label} como comprado`}
        />
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={abierto}
          className="min-w-0 flex-1 text-left"
        >
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span
              className={`min-w-0 truncate font-body-md text-body-md ${
                resuelto ? "text-outline line-through" : "text-on-surface"
              }`}
            >
              {item.label}
            </span>
            {item.source === "MANUAL" && <Chip>manual</Chip>}
            {item.source === "STOCK_INTELLIGENCE" && (
              <Chip tono="primario">sugerido por despensa</Chip>
            )}
            {/* La línea de un evento se marca: si el asado se cancela, la
                0041 la retira y la persona tiene que poder reconocerla acá. */}
            {item.source === "EVENT" && <Chip tono="primario">evento</Chip>}
          </span>
          <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 font-body-sm text-body-sm text-on-surface-variant">
            <span>
              {cantidadIncierta
                ? "cantidad por confirmar"
                : comprar !== null
                  ? formatQuantity(comprar, item.unit)
                  : "sin cantidad"}
              {item.plannedQuantity !== null &&
                item.requiredQuantity !== null &&
                item.plannedQuantity !== item.requiredQuantity && (
                  <span className="text-outline">
                    {" "}
                    (calculado: {formatQuantity(item.requiredQuantity, item.unit)})
                  </span>
                )}
            </span>
            {item.unresolved && <Chip tono="atencion">falta rendimiento</Chip>}
            {enDespensa && enDespensa.quantity > 0 && (
              <Chip tono="primario" icon="home">
                en casa: {formatQuantity(enDespensa.quantity, item.unit)}
              </Chip>
            )}
            {item.status !== "PENDING" && item.status !== "PURCHASED" && (
              <span className="text-outline">· {STATUS_LABELS[item.status]}</span>
            )}
          </span>
        </button>
        <Icon
          name={abierto ? "expand_less" : "expand_more"}
          className="shrink-0 text-outline-variant"
        />
      </div>

      {abierto && (
        <div className="space-y-sm border-t border-outline-variant/40 px-md py-md font-body-sm text-body-sm text-on-surface">
          <div className="flex flex-wrap gap-x-lg gap-y-1">
            <p>
              <span className="text-on-surface-variant">Necesario:</span>{" "}
              {cantidadIncierta || necesario === null
                ? "por confirmar"
                : formatQuantity(necesario, item.unit)}
            </p>
            <p>
              <span className="text-on-surface-variant">Comprar:</span>{" "}
              {cantidadIncierta || comprar === null
                ? "por confirmar"
                : formatQuantity(comprar, item.unit)}
            </p>
            {item.cookedQuantity !== null && (
              <p>
                <span className="text-on-surface-variant">Cocido que se sirve:</span>{" "}
                {formatQuantity(item.cookedQuantity, item.unit)}
                {item.yieldFactor && (
                  <span className="text-outline"> (rendimiento ×{item.yieldFactor})</span>
                )}
              </p>
            )}
          </div>

          {enDespensa && enDespensa.quantity > 0 && item.unresolved && (
            <Notice icon="home" tono="info">
              Tienes {formatQuantity(enDespensa.quantity, item.unit)} en la despensa. No se puede
              decir si alcanza hasta saber cuánto rinde cocido
              {item.plannedQuantity !== null
                ? " (la cantidad fijada a mano es una decisión, no un cálculo)"
                : ""}
              .
            </Notice>
          )}

          {enDespensa &&
            enDespensa.quantity > 0 &&
            !item.unresolved &&
            item.requiredQuantity !== null && (
              <Notice icon="home" tono="info">
                Tienes {formatQuantity(enDespensa.quantity, item.unit)} en la despensa
                {enDespensa.quantity >= item.requiredQuantity
                  ? ": alcanzaría sin comprar. Puedes marcar «Ya lo tengo»."
                  : `: te faltarían ${formatQuantity(item.requiredQuantity - enDespensa.quantity, item.unit)}.`}
              </Notice>
            )}

          {item.unresolvedReason && <Notice icon="help">{item.unresolvedReason}</Notice>}

          {item.provenance.length > 0 && (
            <div>
              <p className="mb-1 font-semibold text-on-surface-variant">¿Por qué necesito esto?</p>
              <ul className="space-y-0.5">
                {item.provenance.map((p, i) => (
                  <li key={i} className="flex justify-between gap-sm">
                    <span className="min-w-0 capitalize">
                      {"kind" in p && p.kind === "EVENT" ? (
                        <>
                          {formatDate(p.date)} · {p.title}
                          <span className="text-outline"> · {p.cut}</span>
                        </>
                      ) : (
                        <>
                          {formatDate(p.date)} · {MEAL_TYPE_LABELS[p.mealType] ?? p.mealType}
                          <span className="text-outline"> · {p.members.join(", ")}</span>
                        </>
                      )}
                    </span>
                    <span className="shrink-0 font-semibold">
                      {/* Un corte que el motor no pudo estimar aporta `null`, y
                          eso NO es cero gramos: se dice con palabras. */}
                      {p.quantity === null
                        ? "cantidad por confirmar"
                        : formatQuantity(p.quantity, item.unit)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!editando ? (
            <div className="flex flex-wrap gap-sm pt-1">
              <ButtonOutline
                disabled={pending}
                onClick={() => {
                  setCantidad(comprar !== null ? String(comprar) : "");
                  setEditando(true);
                }}
              >
                Editar cantidad
              </ButtonOutline>
              <ButtonOutline
                disabled={pending}
                onClick={() => run(() => setItemStatus(item.id, "HAVE_ENOUGH"))}
              >
                Ya lo tengo
              </ButtonOutline>
              <ButtonOutline
                disabled={pending}
                onClick={() => run(() => setItemStatus(item.id, "SKIPPED"))}
              >
                No lo llevo
              </ButtonOutline>
              {item.status !== "PENDING" && (
                <ButtonOutline
                  disabled={pending}
                  onClick={() => run(() => setItemStatus(item.id, "PENDING"))}
                >
                  Volver a pendiente
                </ButtonOutline>
              )}
              {(item.source === "MANUAL" || item.source === "STOCK_INTELLIGENCE") && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => run(() => removeManualItem(item.id))}
                  className="inline-flex items-center justify-center gap-sm rounded-full border border-error-container px-lg py-sm font-body-md text-body-sm font-semibold text-error transition-transform active:scale-95 disabled:opacity-40"
                >
                  Quitar
                </button>
              )}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-sm pt-1">
              <input
                type="number"
                min="0"
                step="any"
                value={cantidad}
                onChange={(e) => setCantidad(e.target.value)}
                placeholder="vacío = calculada"
                className="w-32 rounded-xl border border-outline-variant bg-surface-container-lowest px-md py-sm font-body-md text-body-md text-on-surface"
                aria-label="Cantidad a comprar (vacío vuelve a la calculada)"
              />
              <span className="text-on-surface-variant">
                {item.unit === "G" ? "g" : item.unit === "ML" ? "ml" : "unidades"}
              </span>
              <Button
                disabled={pending}
                onClick={() => {
                  // Vacío = volver a la cantidad calculada. Un "" convertido a
                  // Number daría 0, y comprar 0 por accidente es otra cosa.
                  const texto = cantidad.trim();
                  const n = texto === "" ? null : Number(texto);
                  if (n !== null && !Number.isFinite(n)) return;
                  run(() => editPlannedQuantity(item.id, n));
                  setEditando(false);
                }}
              >
                Guardar
              </Button>
              <ButtonOutline onClick={() => setEditando(false)}>Cancelar</ButtonOutline>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function ManualForm({
  listId,
  pending,
  onSave,
  onCancel,
}: {
  listId: string;
  pending: boolean;
  onSave: (a: () => Promise<{ ok: boolean; error?: string; message?: string }>) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState("");
  const [cantidad, setCantidad] = useState("");
  const [unidad, setUnidad] = useState<"UNIT" | "G" | "ML">("UNIT");

  return (
    <div className="space-y-sm">
      <p className="font-body-sm text-body-sm text-on-surface-variant">
        Algo que no sale de las recetas: detergente, papel, bolsas. Va aparte de lo calculado.
      </p>
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Detergente"
        className={FIELD}
      />
      <div className="flex gap-sm">
        <input
          type="number"
          min="0"
          step="any"
          value={cantidad}
          onChange={(e) => setCantidad(e.target.value)}
          placeholder="Cantidad (opcional)"
          className={FIELD}
        />
        <select
          value={unidad}
          onChange={(e) => setUnidad(e.target.value as "UNIT")}
          className={FIELD}
        >
          <option value="UNIT">unidades</option>
          <option value="G">gramos</option>
          <option value="ML">ml</option>
        </select>
      </div>
      <div className="flex gap-sm">
        <ButtonOutline className="flex-1" onClick={onCancel}>
          Cancelar
        </ButtonOutline>
        <Button
          className="flex-1"
          disabled={pending}
          onClick={() =>
            onSave(async () => {
              const n = cantidad.trim() === "" ? null : Number(cantidad);
              const r = await addManualItem(listId, label, n, unidad);
              if (r.ok) {
                setLabel("");
                setCantidad("");
                onCancel();
              }
              return r;
            })
          }
        >
          Agregar
        </Button>
      </div>
    </div>
  );
}
