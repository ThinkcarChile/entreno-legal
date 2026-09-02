"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Card, Chip, DataRow, ErrorNote, Flotante, Notice } from "@/components/ui";
import { formatearCantidad, formatearGramos, formatearRango } from "../../formato";
import type { EstadoEvento } from "../../vocabulario";
import type { PlanDeCompraDelEvento, SobranteFinal } from "../../compras/lineas";
import type { ComprasDelEvento, LineaGuardada, LoteNoNeteable } from "../../compras/queries";
import { enviarComprasDelEvento } from "../../compras/actions";

/**
 * LO QUE ESTA PANTALLA TIENE PROHIBIDO HACER.
 *
 *  1. Sumar gramos de bases distintas. "Necesitamos" está en peso SERVIBLE (lo
 *     que llega al plato), "tenemos" y "comprar" están en peso de COMPRA (lo
 *     que marca la balanza del súper). Cada número dice en qué base está y
 *     ninguno se resta contra otro de otra base.
 *  2. Mostrar cero cuando el motor dijo "no sé". Un corte sin rendimiento
 *     anotado sale como "no se puede estimar" con su motivo; cero en una lista
 *     de compras es la instrucción "no compres nada".
 *  3. Esconder lo ya comprado cuando el evento se cancela. Esa carne está en el
 *     refrigerador aunque el asado no se haga (§83), y la única forma de que
 *     alguien la use es que la pantalla lo diga.
 */
export function TableroCompras({
  eventoId,
  estadoEvento,
  estadoCrudo,
  plan,
  compras,
  sobrante,
  noNeteables,
}: {
  eventoId: string;
  estadoEvento: EstadoEvento | null;
  estadoCrudo: string;
  plan: PlanDeCompraDelEvento;
  compras: ComprasDelEvento;
  sobrante: SobranteFinal | null;
  noNeteables: LoteNoNeteable[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [avisos, setAvisos] = useState<string[]>([]);

  const cancelado = estadoEvento === "CANCELLED";
  const terminado = estadoEvento === "COMPLETED";

  const compradas = compras.lineas.filter((l) => l.estado === "PURCHASED");
  const retiradas = compras.lineas.filter((l) => l.estado === "SKIPPED");
  const pendientes = compras.lineas.filter((l) => l.estado === "PENDING");

  const enviar = () => {
    setError(null);
    setMensaje(null);
    start(async () => {
      const r = await enviarComprasDelEvento({ eventoId });
      if (!r.ok) {
        setError(r.error ?? "No se pudo mandar la compra.");
        setAvisos(r.avisos ?? []);
        return;
      }
      setMensaje(r.message ?? "Listo.");
      setAvisos(r.avisos ?? []);
      router.refresh();
    });
  };

  return (
    <div className="space-y-lg">
      {estadoEvento === null && (
        <Notice icon="help" tono="atencion">
          Este evento está en un estado que esta versión de la aplicación no conoce
          ({estadoCrudo}). Actualízala antes de mandar nada a la compra.
        </Notice>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* §33: necesitamos / tenemos / comprar                              */}
      {/* ---------------------------------------------------------------- */}
      <Card className="space-y-md p-md">
        <h3 className="font-headline-sm text-headline-sm text-on-surface">Las tres cantidades</h3>
        <DataRow label="Necesitamos (peso servible)">
          {formatearRango(plan.resumen.servible)}
        </DataRow>
        <DataRow label="Tenemos utilizable (peso de compra)">
          {formatearGramos(plan.resumen.inventarioNeteado)}
        </DataRow>
        <DataRow label="Comprar (peso de compra)">
          {formatearCantidad(plan.resumen.compra)}
        </DataRow>
        <p className="font-body-sm text-body-sm text-on-surface-variant">
          Las dos primeras cifras NO se restan entre sí: una está en lo que llega al plato y la
          otra en lo que marca la balanza. La conversión entre las dos la hace el motor corte por
          corte, con el rendimiento de cada uno.
        </p>

        {plan.resumen.inventarioSinBase > 0 && (
          <Notice icon="help" tono="atencion">
            Hay {formatearGramos(plan.resumen.inventarioSinBase)} en la despensa que no se
            descontaron: están pesados en una base que no se puede convertir a peso de compra
            (escurrido, o como viene el envase). Existen de verdad, pero no se puede afirmar
            cuánto de eso llega al plato, así que la compra quedó calculada sin contarlos.
          </Notice>
        )}

        {noNeteables.length > 0 && (
          <Notice icon="inventory_2" tono="atencion">
            En la despensa hay {noNeteables.map((l) => `${l.label} (${l.cantidad} ${l.unidad === "UNIT" ? "u" : "ml"})`).join(", ")} de
            estos mismos cortes, contados en unidades. La estimación trabaja en gramos y nadie
            declaró cuánto pesa cada una, así que no se descontaron: revísalos antes de ir al súper.
          </Notice>
        )}
      </Card>

      {/* ---------------------------------------------------------------- */}
      {/* Sobrante DESPUÉS del redondeo comercial                          */}
      {/* ---------------------------------------------------------------- */}
      {sobrante !== null && (
        <Card className="space-y-sm p-md">
          <h3 className="font-headline-sm text-headline-sm text-on-surface">Cuánto va a sobrar</h3>
          {sobrante.conocido ? (
            <>
              <DataRow label="Sobrante estimado (peso servible)">
                {formatearRango(sobrante.rango)}
              </DataRow>
              {sobrante.extraDeCompra > 0 && (
                <p className="font-body-sm text-body-sm text-on-surface-variant">
                  Incluye {formatearGramos(sobrante.extraDeCompra)} de compra por encima de lo
                  recomendado: los envases del proveedor no vienen del tamaño exacto que se
                  necesita, o alguien ajustó la cantidad a mano. Esa carne de más también termina
                  en la mesa.
                </p>
              )}
            </>
          ) : (
            <>
              <DataRow label="Sobrante estimado (piso)">
                {formatearRango(sobrante.alMenos)}
              </DataRow>
              <Notice icon="help" tono="atencion">
                {sobrante.motivo}
              </Notice>
            </>
          )}
        </Card>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* El desglose por línea de compra                                  */}
      {/* ---------------------------------------------------------------- */}
      <Card className="space-y-md p-md">
        <h3 className="font-headline-sm text-headline-sm text-on-surface">Desglose</h3>
        <ul className="space-y-sm">
          {plan.lineas.map((linea) => (
            <li key={linea.lineKey} className="border-b border-outline-variant pb-sm last:border-0">
              <div className="flex flex-wrap items-baseline justify-between gap-sm">
                <span className="font-body-md text-body-md text-on-surface">{linea.label}</span>
                <span className="font-body-md text-body-md font-semibold text-on-surface">
                  {linea.rango === null ? "No se puede estimar" : formatearRango(linea.rango)}
                </span>
              </div>
              {linea.motivo && (
                <p className="mt-1 font-body-sm text-body-sm text-on-surface-variant">
                  {linea.motivo}
                </p>
              )}
              <ul className="mt-1 space-y-0.5 font-body-sm text-body-sm text-on-surface-variant">
                {linea.procedencia.map((p) => (
                  <li key={p.itemId} className="flex justify-between gap-sm">
                    <span className="min-w-0 truncate">{p.cut}</span>
                    <span className="shrink-0">
                      {/* `null` acá es "no se pudo estimar este corte", que no
                          es lo mismo que "no hace falta comprar nada". */}
                      {p.quantity === null ? "por confirmar" : formatearGramos(p.quantity)}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
        {plan.avisos.map((a) => (
          <Notice key={a} icon="help" tono="atencion">
            {a}
          </Notice>
        ))}
      </Card>

      {/* ---------------------------------------------------------------- */}
      {/* Lo que ya está escrito en la lista                                */}
      {/* ---------------------------------------------------------------- */}
      <Card className="space-y-md p-md">
        <h3 className="font-headline-sm text-headline-sm text-on-surface">En la lista de compras</h3>

        {compras.lineas.length === 0 ? (
          <p className="font-body-md text-body-md text-on-surface-variant">
            Todavía no mandaste nada de este evento a la lista de compras.
          </p>
        ) : (
          <>
            {compras.delta !== null && (
              <Notice icon="shopping_cart">
                La compra de esa semana ya estaba cerrada, así que lo que falta quedó en una lista
                aparte de este evento. La lista de la semana no se reescribió.
              </Notice>
            )}
            <ul className="space-y-sm">
              {compras.lineas.map((linea) => (
                <LineaEnLista key={linea.id} linea={linea} />
              ))}
            </ul>
          </>
        )}

        <Link
          href="/shopping"
          className="inline-block font-body-md text-body-sm font-semibold text-primary underline"
        >
          Ver la lista completa de compras
        </Link>
      </Card>

      {/* ---------------------------------------------------------------- */}
      {/* Cancelado: qué pasó con lo pedido y con lo comprado (§83)         */}
      {/* ---------------------------------------------------------------- */}
      {cancelado && (
        <Card className="space-y-md p-md">
          <h3 className="font-headline-sm text-headline-sm text-on-surface">Este evento está cancelado</h3>
          <p className="font-body-md text-body-md text-on-surface">
            {retiradas.length > 0
              ? `Se retiraron ${retiradas.length} ${retiradas.length === 1 ? "línea" : "líneas"} de la lista de compras: ya no se piden.`
              : "No quedaba ninguna línea pendiente que retirar de la lista de compras."}
          </p>
          {pendientes.length > 0 && (
            <Notice icon="warning" tono="atencion">
              Todavía hay {pendientes.length} línea(s) pendiente(s) de este evento en la lista.
              Vuelve a abrir la pantalla; si siguen ahí, retíralas a mano desde Compras.
            </Notice>
          )}
          {compradas.length > 0 ? (
            <Notice icon="inventory_2" tono="atencion">
              Ya compraste {compradas.map((l) => l.label).join(", ")}. Eso NO se borra ni se
              devuelve solo: está en tu casa. Puedes usarlo en la semana, congelarlo si es seguro,
              o dejarlo en la despensa — la decisión es tuya y el sistema no la toma por ti.
            </Notice>
          ) : (
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              No alcanzaste a comprar nada para este evento.
            </p>
          )}
        </Card>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* La acción                                                         */}
      {/* ---------------------------------------------------------------- */}
      {!cancelado && !terminado && (
        <Card className="space-y-md p-md">
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            Esto escribe la demanda del evento en tu lista de compras de esa semana. No crea una
            lista aparte, no toca lo que ya compraste y no cambia las cantidades que hayas
            ajustado a mano.
          </p>
          <Button onClick={enviar} disabled={pending}>
            {compras.lineas.length === 0 ? "Mandar a la compra" : "Actualizar la compra"}
          </Button>
        </Card>
      )}

      {error && <ErrorNote>{error}</ErrorNote>}
      {avisos.map((a) => (
        <Notice key={a} icon="help" tono="atencion">
          {a}
        </Notice>
      ))}
      {mensaje && <Flotante tono="ok">{mensaje}</Flotante>}
    </div>
  );
}

const ETIQUETA_ESTADO: Record<LineaGuardada["estado"], string> = {
  PENDING: "por comprar",
  PURCHASED: "comprado",
  SKIPPED: "retirado",
  HAVE_ENOUGH: "ya lo tengo",
};

function LineaEnLista({ linea }: { linea: LineaGuardada }) {
  const cantidad = linea.planificado ?? linea.requerido;
  return (
    <li className="border-b border-outline-variant pb-sm last:border-0">
      <div className="flex flex-wrap items-baseline justify-between gap-sm">
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="font-body-md text-body-md text-on-surface">{linea.label}</span>
          <Chip tono={linea.estado === "PURCHASED" ? "primario" : undefined}>
            {ETIQUETA_ESTADO[linea.estado]}
          </Chip>
        </span>
        <span className="font-body-md text-body-md font-semibold text-on-surface">
          {/* Sin cantidad NO se dibuja un 0: la línea existe justamente porque
              hay que comprar algo cuya cantidad nadie pudo calcular. */}
          {cantidad === null || linea.unidad !== "G"
            ? "cantidad por confirmar"
            : formatearGramos(cantidad)}
        </span>
      </div>
      {linea.motivoEstado && (
        <p className="mt-1 font-body-sm text-body-sm text-on-surface-variant">
          {linea.motivoEstado}
        </p>
      )}
      {linea.motivo && (
        <p className="mt-1 font-body-sm text-body-sm text-on-surface-variant">{linea.motivo}</p>
      )}
    </li>
  );
}
