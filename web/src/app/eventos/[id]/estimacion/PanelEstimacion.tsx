"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Button,
  ButtonOutline,
  CAMPO,
  Card,
  Chip,
  DataRow,
  ErrorNote,
  Flotante,
  Icon,
  Notice,
  Section,
  TextField,
} from "@/components/ui";
import type { BbqBatches, BbqCutPlan, RangeOrUnknown } from "@/domain/events/bbq/types";
import type { Revision } from "../../contrato-estimacion";
import {
  ANCHO_AMPLIO,
  anchoRelativo,
  formatearCantidad,
  formatearGramos,
  formatearInventario,
  formatearRango,
  personas,
  TEXTO_CONFIANZA,
  TEXTO_MOTIVO,
  TONO_CONFIANZA,
} from "../../formato";
import {
  ETIQUETA_ACOMPANAMIENTO,
  ETIQUETA_CATEGORIA,
  ETIQUETA_CONTEXTO,
  ETIQUETA_SOBRANTE,
  SIN_INFORMACION,
} from "../../vocabulario";
import { guardarOverride } from "../../actions";

/**
 * El resultado del cálculo.
 *
 * Las cuatro reglas que esta pantalla hace cumplir, y por las que existe:
 *
 *  1. TODO ES UN RANGO. Nunca "8,4 kg" a secas. Un número seco se lee como una
 *     medición y esto es una estimación; el ancho del rango es información, no
 *     ruido que haya que esconder.
 *
 *  2. LOS SUPUESTOS ESTÁN A LA VISTA. Cuántos adultos, cuántos niños, qué
 *     contexto, cuántos acompañamientos, qué margen. Sin eso el número es un
 *     oráculo, y a un oráculo no se le puede discutir.
 *
 *  3. LO QUE EL MOTOR NO PUDO ESTIMAR SE DICE. Si un corte no tiene factor de
 *     rendimiento, la línea dice que no se puede estimar y muestra el motivo.
 *     No se rellena con el crudo, no se pone un guión, no se pone cero.
 *
 *  4. NADA CLÍNICO. Los conteos son conteos; no hay nombres, ni banderas de
 *     nadie en particular, ni una sola palabra de salud.
 */
export function PanelEstimacion({
  eventoId,
  revision,
}: {
  eventoId: string;
  revision: Revision;
}) {
  const router = useRouter();
  const [pendiente, empezar] = useTransition();
  const [porQue, setPorQue] = useState(false);
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [miCantidadKg, setMiCantidadKg] = useState(
    revision.overrideG === null ? "" : String(revision.overrideG / 1000),
  );
  const [nota, setNota] = useState(revision.overrideNota ?? "");

  const salida = revision.salida;
  const entrada = revision.entrada;
  const ancho = anchoRelativo(salida.totalServableDemand);

  function guardarMiCantidad(borrar: boolean) {
    setError(null);
    setMensaje(null);
    const kg = Number(miCantidadKg.replace(",", "."));
    if (!borrar && (!Number.isFinite(kg) || kg <= 0)) {
      setError("Escribe cuántos kilos quieres comprar, por ejemplo 9,5.");
      return;
    }
    empezar(async () => {
      const r = await guardarOverride({
        eventoId,
        revisionId: revision.id,
        gramos: borrar ? null : Math.round(kg * 1000),
        nota: borrar || nota.trim().length === 0 ? null : nota.trim(),
      });
      if (!r.ok) {
        setError(r.error ?? "No se pudo guardar tu cantidad.");
        return;
      }
      setMensaje(r.message ?? "Guardado.");
      router.refresh();
    });
  }

  return (
    <div className="space-y-lg">
      {mensaje && <Flotante tono="ok">{mensaje}</Flotante>}
      {error && <ErrorNote>{error}</ErrorNote>}

      {salida.reviewRequired.length > 0 && (
        <Notice icon="warning">
          <p className="font-semibold">Esto necesita que lo mires antes de comprar:</p>
          <ul className="mt-1 list-disc pl-5">
            {salida.reviewRequired.map((r, i) => (
              <li key={`${r.code}-${i}`}>{r.text}</li>
            ))}
          </ul>
        </Notice>
      )}

      <Card className="space-y-md p-md">
        <p className="font-body-sm text-body-sm text-on-surface-variant">
          Carne servible que se necesita
        </p>
        <p className="font-headline-lg text-headline-lg text-on-surface">
          {formatearRango(salida.totalServableDemand)}
        </p>
        <div className="flex flex-wrap gap-sm">
          <Chip tono={TONO_CONFIANZA[salida.confidence]}>{TEXTO_CONFIANZA[salida.confidence]}</Chip>
          <Chip icon="group">{personas(salida.headcount.counted)} que comen</Chip>
          <Chip>Revisión #{revision.numero}</Chip>
        </div>

        {ancho !== null && ancho > ANCHO_AMPLIO && (
          // El ancho del rango no es un detalle: es la señal de cuánta
          // información falta. Si es grande hay que decirlo con palabras, no
          // esperar que alguien reste el mínimo del máximo.
          <Notice icon="unfold_more">
            El rango es ancho porque falta información de varias personas. Mientras más se sepa de
            apetitos y edades, más se angosta.
          </Notice>
        )}

        {salida.uncoveredServableDemand !== null && (
          // Gente que no tiene NADA que pueda comer en este menú. Su demanda no
          // se reparte entre cortes que no puede comer: se declara aparte.
          <Notice icon="no_meals">
            Hay {formatearRango(salida.uncoveredServableDemand)} de comida para personas que no
            tienen nada compatible en este menú. Esa cantidad no está repartida entre los cortes de
            abajo.
          </Notice>
        )}

        <ButtonOutline onClick={() => setPorQue(!porQue)}>
          <Icon name={porQue ? "expand_less" : "expand_more"} className="text-[18px]" />
          ¿POR QUÉ ESTA CANTIDAD?
        </ButtonOutline>

        {porQue && <PorQue revision={revision} />}
      </Card>

      <Section
        title="Corte por corte"
        hint="Servible, crudo, lo que ya tienes y lo que falta comprar."
      >
        <ul className="space-y-md">
          {salida.byCut.map((linea) => (
            <li key={linea.itemId}>
              <TarjetaCorte linea={linea} />
            </li>
          ))}
        </ul>

        <div className="mt-md">
          <Card className="p-md">
            <DataRow label="Total a comprar (antes del formato de venta)">
              {formatearCantidad(salida.totalPurchaseRequired)}
            </DataRow>
            {!salida.totalPurchaseRequired.known && (
              // No se suma lo que no se sabe: el subtotal de las líneas
              // completas se muestra aparte y rotulado, para que nadie lo lea
              // como si fuera el total.
              <p className="font-body-sm text-body-sm text-on-surface-variant">
                De los cortes que sí tienen rendimiento suman{" "}
                {formatearRango(salida.knownPurchaseSubtotal)}. Los otros no se pueden sumar sin
                inventarlos.
              </p>
            )}
          </Card>
        </div>
      </Section>

      <Section title="Lo que probablemente sobre">
        <Card className="space-y-sm p-md">
          <DataRow label="Sobrante estimado">
            {formatearRango(salida.expectedLeftovers.range)}
          </DataRow>
          {/* El motor no conoce el redondeo comercial: si el proveedor vende en
              cajas de 5 kg, los kilos de más que llegan por la caja no están en
              este número. Decirlo acá evita que después parezcan dos cuentas
              que no cuadran. */}
          <p className="font-body-sm text-body-sm text-outline">
            Esto es antes de la presentación comercial. Si la carne se vende en formatos fijos, lo
            que sobre de verdad puede ser más: eso se ve al armar la compra.
          </p>
        </Card>
      </Section>

      <Section title="Tu cantidad" hint="Siempre puedes comprar distinto de lo recomendado.">
        <Card className="space-y-md p-md">
          <DataRow label="Recomendado">{formatearRango(salida.totalServableDemand)}</DataRow>
          <DataRow label="Tu plan">
            {revision.overrideG === null
              ? "Igual a lo recomendado"
              : formatearGramos(revision.overrideG)}
          </DataRow>
          <label className="block">
            <span className="font-body-sm text-body-sm text-on-surface-variant">
              Quiero comprar (kg)
            </span>
            <input
              value={miCantidadKg}
              onChange={(e) => setMiCantidadKg(e.target.value)}
              inputMode="decimal"
              placeholder="9,5"
              className={`${CAMPO} mt-1`}
            />
          </label>
          <TextField
            label="¿Por qué? (opcional)"
            value={nota}
            onChange={setNota}
            multiline
            placeholder="Mi familia come mucho / quiero que sobre para el domingo"
            hint="Queda anotado solo en este evento: no le cambia nada a los que vengan."
          />
          <div className="flex flex-wrap gap-sm">
            <Button disabled={pendiente} onClick={() => guardarMiCantidad(false)}>
              Guardar mi cantidad
            </Button>
            {revision.overrideG !== null && (
              <ButtonOutline disabled={pendiente} onClick={() => guardarMiCantidad(true)}>
                Volver a lo recomendado
              </ButtonOutline>
            )}
          </div>
        </Card>
      </Section>

      <Card className="space-y-sm p-md">
        <p className="font-body-sm text-body-sm text-on-surface-variant">
          Calculado con {salida.engineVersion} y la política {salida.policyVersion}, congelados en
          esta revisión. Si mañana cambia la forma de calcular, este número no cambia: es el que se
          usó para comprar.
        </p>
        <p className="font-body-sm text-body-sm text-outline">
          Contexto: {entrada.mealContext ? ETIQUETA_CONTEXTO[entrada.mealContext] : SIN_INFORMACION}{" "}
          · Acompañamientos:{" "}
          {entrada.sidesLevel ? ETIQUETA_ACOMPANAMIENTO[entrada.sidesLevel] : SIN_INFORMACION} ·
          Sobrante:{" "}
          {entrada.desiredLeftover.kind
            ? ETIQUETA_SOBRANTE[entrada.desiredLeftover.kind]
            : SIN_INFORMACION}{" "}
          · Margen:{" "}
          {entrada.safetyBufferPct === null
            ? SIN_INFORMACION
            : `${entrada.safetyBufferPct.toLocaleString("es-CL")} %`}
        </p>
        <p className="font-body-sm text-body-sm text-outline">
          La cantidad base es política de producto ({salida.policySource}), no una recomendación
          médica.
        </p>
      </Card>

      <p className="font-body-sm text-body-sm text-outline">
        <Link href={`/eventos/${eventoId}`} className="underline">
          Volver al evento
        </Link>
      </p>
    </div>
  );
}

/**
 * El panel del "¿por qué?".
 *
 * Muestra los CONTEOS y las razones que el motor emitió, en el mismo formato
 * {código, parámetros, texto} que usan las porciones desde el Sprint 4. No hay
 * fórmulas: una fórmula no le contesta a nadie por qué hay que comprar nueve
 * kilos. Y no hay nombres de personas, por diseño — el hecho relevante es que
 * son cuatro los que comen harto, no quiénes.
 */
function PorQue({ revision }: { revision: Revision }) {
  const h = revision.salida.headcount;
  const c = revision.salida.coverage;
  const d = revision.salida.demand;
  // La cobertura del motor es una FRACCIÓN (0..1) sobre la gente que cuenta
  // para el cálculo, no un conteo: restarla de `participants` imprimía cosas
  // como "10,18 sin información de restricciones". Acá se vuelve a personas.
  const personasQueCuentan = h.counted;
  const sinApetito = Math.round(personasQueCuentan * (1 - c.appetiteKnown));
  const sinInfoDietaria = Math.round(personasQueCuentan * (1 - c.dietaryInfoKnown));

  return (
    <div className="space-y-md rounded-2xl bg-surface-container p-md">
      <ul className="space-y-1 font-body-sm text-body-sm text-on-surface">
        <li>{h.adults} adultos</li>
        <li>{h.children} niños</li>
        {h.unknownAge > 0 && <li>{h.unknownAge} sin información de edad</li>}
        <li>
          {h.byAttendance.CONFIRMED} confirmados · {h.byAttendance.MAYBE} tal vez ·{" "}
          {h.byAttendance.INVITED} invitados sin responder
        </li>
        {sinApetito > 0 && <li>{sinApetito} sin información de cuánto comen</li>}
        {/* Esta línea aparece SIEMPRE que haya alguien de quien NADIE sabe: ni
            declaró banderas ni tiene ficha en la casa. Es el caso en que el
            plan trataría a esa persona como "sin restricciones" sin que nadie
            lo haya dicho. Los integrantes del hogar ya no caen acá: de ellos la
            app sabe por ingrediente, y el motor lo usa. */}
        {sinInfoDietaria > 0 && (
          <li className="font-semibold">
            {sinInfoDietaria} sin información de restricciones — conviene preguntar antes de comprar
          </li>
        )}
        <li>Lo que se estima que comen: {formatearRango(d.participants)}</li>
        {d.desiredLeftoverGrams > 0 && (
          <li>Sobrante que pediste: {formatearGramos(d.desiredLeftoverGrams)}</li>
        )}
        <li>Margen por si acaso: {formatearRango(d.safetyBuffer)}</li>
      </ul>

      {revision.salida.reasons.length > 0 && (
        <ul className="space-y-sm">
          {revision.salida.reasons.map((r, i) => (
            <li key={`${r.code}-${i}`} className="font-body-sm text-body-sm text-on-surface-variant">
              {r.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Una cantidad que puede no existir, con el motivo escrito cuando no existe. */
function FilaCantidad({ label, cantidad }: { label: string; cantidad: RangeOrUnknown }) {
  return (
    <DataRow label={label}>
      {cantidad.known ? (
        formatearCantidad(cantidad)
      ) : (
        <span className="text-on-error-container">{formatearCantidad(cantidad)}</span>
      )}
    </DataRow>
  );
}

/** Las tandas: exactas, un rango, o el motivo por el que no se saben. */
function textoTandas(batches: BbqBatches): string {
  if (!batches.known) return `${SIN_INFORMACION} — ${TEXTO_MOTIVO[batches.reason]}`;
  if (batches.kind === "EXACT") {
    return `${batches.batches} ${batches.batches === 1 ? "tanda" : "tandas"}`;
  }
  return `entre ${batches.min} y ${batches.max} tandas`;
}

function TarjetaCorte({ linea }: { linea: BbqCutPlan }) {
  const desconocido = !linea.rawPurchase.known || !linea.purchaseRequired.known;

  return (
    <Card className="space-y-sm p-md">
      <div className="flex flex-wrap items-center justify-between gap-sm">
        <p className="font-headline-sm text-headline-sm text-on-surface">{linea.displayName}</p>
        <div className="flex flex-wrap gap-sm">
          {linea.category ? (
            <Chip>{ETIQUETA_CATEGORIA[linea.category]}</Chip>
          ) : (
            <Chip tono="atencion">Sin categoría</Chip>
          )}
        </div>
      </div>

      {desconocido && (
        <Notice icon="warning">
          De este corte no tenemos la cadena completa de rendimientos. No lo convertimos uno a uno:
          cinco kilos crudos no son cinco kilos servibles y suponerlo dejaría la mesa corta.
        </Notice>
      )}

      <DataRow label="Servible (lo que va al plato)">{formatearRango(linea.servable)}</DataRow>
      <FilaCantidad label="Cocido que hace falta" cantidad={linea.cooked} />
      <FilaCantidad label="Crudo limpio" cantidad={linea.rawEdible} />
      <FilaCantidad label="Crudo de compra (con hueso y merma)" cantidad={linea.rawPurchase} />
      <DataRow label="Ya tienes">{formatearInventario(linea.inventoryToUse)}</DataRow>
      <FilaCantidad label="Falta comprar" cantidad={linea.purchaseRequired} />

      {linea.inventoryToUse.known && linea.inventoryToUse.frozenGrams > 0 && (
        <Notice icon="ac_unit">
          {formatearGramos(linea.inventoryToUse.frozenGrams)} de lo que tienes está congelado: hay
          que sacarlo con tiempo.
        </Notice>
      )}

      <p className="font-body-sm text-body-sm text-on-surface-variant">
        Tandas: {textoTandas(linea.batches)}
      </p>

      {linea.flags.length > 0 && (
        <ul className="space-y-1">
          {linea.flags.map((f) => (
            <li key={f} className="font-body-sm text-body-sm text-outline">
              {TEXTO_MOTIVO[f]}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
