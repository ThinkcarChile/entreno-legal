"use client";

import { useRef, useState, useTransition } from "react";
import { Button, Card, CAMPO, ErrorNote, Flotante, Notice, Section } from "@/components/ui";
import {
  anularServido,
  botarDelEvento,
  guardarSobra,
  servirEnElEvento,
} from "../../servicio-actions";
import type { RenglonServido } from "../../servicio-queries";
import type { ItemMenu } from "../../queries";
import { formatearGramos } from "../../formato";
import { nuevaClaveDeIntento } from "../../clave-intento";

/**
 * La pantalla de la parrilla: qué salió a la mesa, qué volvió y qué se botó.
 *
 * CINCO DECISIONES QUE SE VEN ACÁ:
 *
 *  1. Servir es UN campo y un botón. Con las manos ocupadas nadie llena un
 *     formulario de ocho campos, y una fuente que no se anota es un hueco en el
 *     resumen y en el aprendizaje de todos los asados siguientes.
 *
 *  2. El faltante se MUESTRA. Si de 1.400 g servidos el libro mayor sólo pudo
 *     respaldar 900, la pantalla lo dice con esas palabras: la carne existió
 *     igual, lo que falta es de dónde salió. Esconderlo haría creer que la
 *     despensa tiene 500 g que no tiene.
 *
 *  3. Guardar la sobra se ofrece POR RENGLÓN y topado por lo que ese renglón
 *     sirvió. No hay un campo suelto de "sobras del asado": la conservación de
 *     masa se sostiene renglón por renglón o no se sostiene.
 *
 *  4. CADA ESCRITURA MANDA SU CLAVE DE INTENTO, generada acá y soltada recién
 *     cuando el servidor confirmó. Es la única defensa válida contra el doble
 *     clic: si la clave la dedujera el servidor del contenido, la segunda fuente
 *     de 800 g que sale de verdad a la mesa desaparecería (ver `clave-intento`).
 *
 *  5. Botar y anular EXISTEN. Sin ellos la merma del asado era estructuralmente
 *     cero —un cero que nadie midió, mostrado como dato duro— y un "18000"
 *     tecleado en vez de "1800" quedaba escrito para siempre.
 */
export function PanelDeServicio({
  eventoId,
  menu,
  servido,
}: {
  eventoId: string;
  menu: ItemMenu[];
  servido: RenglonServido[];
}) {
  const [pendiente, empezar] = useTransition();
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [itemId, setItemId] = useState<string>("");
  const [etiqueta, setEtiqueta] = useState<string>("");
  const [gramos, setGramos] = useState<string>("");
  const [tanda, setTanda] = useState<string>("");

  // La clave del intento EN CURSO. Vive en un ref y no en estado porque el
  // segundo clic tiene que leer la misma clave en el mismo tick: un `useState`
  // todavía no se habría actualizado y los dos apretones irían sin clave.
  const claveServido = useRef<string | null>(null);

  const carnes = menu.filter((m) => m.tipo === "MEAT" || m.tipo === "SIDE");

  function correr(accion: () => Promise<{ ok: boolean; error?: string; message?: string }>) {
    setError(null);
    setMensaje(null);
    empezar(async () => {
      const r = await accion();
      if (!r.ok) {
        setError(r.error ?? "No se pudo registrar.");
        return;
      }
      setMensaje(r.message ?? "Listo.");
    });
  }

  function anotarServido() {
    const elegido = carnes.find((c) => c.id === itemId);
    const nombre = elegido !== undefined ? elegido.nombre : etiqueta.trim();
    const cantidad = Number(gramos.replace(",", "."));

    if (nombre.length === 0) {
      setError("Dime qué saliste a servir: elige un item del menú o escribe su nombre.");
      return;
    }
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      setError("Los gramos tienen que ser un número mayor que cero.");
      return;
    }
    const numeroTanda = tanda.trim().length === 0 ? null : Number(tanda);

    // Si ya hay un intento en curso (el mismo apretón repetido), se reusa su
    // clave. Recién cuando el servidor confirma se suelta, y la fuente
    // siguiente —aunque sea idéntica— nace con clave propia.
    if (claveServido.current === null) {
      claveServido.current = nuevaClaveDeIntento(globalThis.crypto);
    }
    const clave = claveServido.current;

    correr(async () => {
      const r = await servirEnElEvento({
        eventoId,
        itemMenuId: elegido !== undefined ? elegido.id : null,
        ingredientId: elegido?.ingredientId ?? null,
        etiqueta: nombre,
        cantidad,
        base: "COOKED",
        tanda:
          numeroTanda !== null && Number.isInteger(numeroTanda) && numeroTanda > 0
            ? numeroTanda
            : null,
        clave,
      });
      if (r.ok) {
        setGramos("");
        claveServido.current = null;
      }
      return r;
    });
  }

  return (
    <div className="space-y-lg">
      {mensaje && <Flotante tono="ok">{mensaje}</Flotante>}
      {error && <ErrorNote>{error}</ErrorNote>}

      <Section
        title="¿Qué sacaste a la mesa?"
        hint="Se anota en peso COCIDO y se descuenta de la despensa una sola vez."
      >
        <Card className="space-y-md p-md">
          {carnes.length > 0 && (
            <label className="block">
              <span className="font-body-sm text-body-sm text-on-surface-variant">Del menú</span>
              <select
                className={CAMPO}
                value={itemId}
                onChange={(e) => setItemId(e.target.value)}
                disabled={pendiente}
              >
                <option value="">Otra cosa (la escribo)</option>
                {carnes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nombre}
                  </option>
                ))}
              </select>
            </label>
          )}

          {itemId === "" && (
            <label className="block">
              <span className="font-body-sm text-body-sm text-on-surface-variant">Qué es</span>
              <input
                className={CAMPO}
                value={etiqueta}
                onChange={(e) => setEtiqueta(e.target.value)}
                placeholder="Longaniza, choripán, pollo…"
                disabled={pendiente}
              />
            </label>
          )}

          <div className="flex flex-wrap gap-md">
            <label className="min-w-[8rem] flex-1">
              <span className="font-body-sm text-body-sm text-on-surface-variant">Gramos</span>
              <input
                className={CAMPO}
                inputMode="decimal"
                value={gramos}
                onChange={(e) => setGramos(e.target.value)}
                placeholder="1400"
                disabled={pendiente}
              />
            </label>
            <label className="min-w-[8rem] flex-1">
              <span className="font-body-sm text-body-sm text-on-surface-variant">
                Tanda (opcional)
              </span>
              <input
                className={CAMPO}
                inputMode="numeric"
                value={tanda}
                onChange={(e) => setTanda(e.target.value)}
                placeholder="1"
                disabled={pendiente}
              />
            </label>
          </div>

          <Button onClick={anotarServido} disabled={pendiente}>
            Salió a la mesa
          </Button>
        </Card>
      </Section>

      <Section title="Lo que ya salió">
        {servido.length === 0 ? (
          <Card className="p-md">
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              Todavía no se anotó nada. Eso no quiere decir que no se haya servido: quiere decir
              que nadie lo anotó.
            </p>
          </Card>
        ) : (
          <ul className="space-y-sm">
            {servido.map((r) => (
              <RenglonServidoCard
                key={r.id}
                eventoId={eventoId}
                renglon={r}
                pendiente={pendiente}
                onCorrer={correr}
              />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function RenglonServidoCard({
  eventoId,
  renglon,
  pendiente,
  onCorrer,
}: {
  eventoId: string;
  renglon: RenglonServido;
  pendiente: boolean;
  onCorrer: (accion: () => Promise<{ ok: boolean; error?: string; message?: string }>) => void;
}) {
  const [sobra, setSobra] = useState<string>("");
  const [usarEl, setUsarEl] = useState<string>("");
  const [abierto, setAbierto] = useState(false);

  const [botado, setBotado] = useState<string>("");
  const [motivoBotado, setMotivoBotado] = useState<string>("");
  const [abiertoBotar, setAbiertoBotar] = useState(false);

  const [motivoAnular, setMotivoAnular] = useState<string>("");
  const [abiertoAnular, setAbiertoAnular] = useState(false);

  const claveSobra = useRef<string | null>(null);
  const claveBotado = useRef<string | null>(null);

  const sinRespaldo = Math.max(renglon.cantidad - renglon.descontado, 0);
  // El tope se calcula acá SOLO para no ofrecer un botón que la base va a
  // rechazar. La pared de verdad está en el candado del libro mayor.
  const disponibleParaGuardar = Math.max(renglon.cantidad - renglon.guardado - renglon.botado, 0);

  return (
    <li>
      <Card className="space-y-sm p-md">
        <div className="flex flex-wrap items-baseline justify-between gap-sm">
          <span className="font-body-md text-body-md font-semibold text-on-surface">
            {renglon.label}
          </span>
          <span className="font-body-md text-body-md text-on-surface">
            {formatearGramos(renglon.cantidad)}
            {renglon.tanda !== null && (
              <span className="ml-2 font-body-sm text-body-sm text-outline">
                tanda {renglon.tanda}
              </span>
            )}
          </span>
        </div>

        {sinRespaldo > 0 && (
          <Notice icon="help">
            {formatearGramos(sinRespaldo)} de esto no salieron de un lote registrado. La comida
            existió igual; lo que no sabemos es de dónde salió.
          </Notice>
        )}

        {renglon.guardado > 0 && (
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            Ya guardaste {formatearGramos(renglon.guardado)} de sobra.
          </p>
        )}

        {renglon.botado > 0 && (
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            Anotaste {formatearGramos(renglon.botado)} botados de esta fuente.
          </p>
        )}

        {!abierto ? (
          <button
            type="button"
            className="min-h-[44px] font-body-sm text-body-sm text-primary underline"
            onClick={() => setAbierto(true)}
            disabled={pendiente || disponibleParaGuardar <= 0}
          >
            {disponibleParaGuardar <= 0
              ? "No queda nada por guardar de esta fuente"
              : "Guardar lo que sobró"}
          </button>
        ) : (
          <div className="flex flex-wrap items-end gap-sm">
            <label className="min-w-[8rem] flex-1">
              <span className="font-body-sm text-body-sm text-on-surface-variant">
                Gramos que guardas (hasta {formatearGramos(disponibleParaGuardar)})
              </span>
              <input
                className={CAMPO}
                inputMode="decimal"
                value={sobra}
                onChange={(e) => setSobra(e.target.value)}
                placeholder="800"
                disabled={pendiente}
              />
            </label>
            <label className="min-w-[9rem] flex-1">
              {/*
                §58: se OFRECE usarla, no se mete sola en la semana. Esto marca
                una intención sobre el lote; el plan del martes no cambia solo
                porque alguien guardó carne el sábado.
              */}
              <span className="font-body-sm text-body-sm text-on-surface-variant">
                ¿La piensas usar tal día? (opcional)
              </span>
              <input
                className={CAMPO}
                type="date"
                value={usarEl}
                onChange={(e) => setUsarEl(e.target.value)}
                disabled={pendiente}
              />
            </label>
            <Button
              disabled={pendiente}
              onClick={() => {
                const cantidad = Number(sobra.replace(",", "."));
                if (!Number.isFinite(cantidad) || cantidad <= 0) return;
                if (claveSobra.current === null) {
                  claveSobra.current = nuevaClaveDeIntento(globalThis.crypto);
                }
                const clave = claveSobra.current;
                onCorrer(async () => {
                  const r = await guardarSobra({
                    eventoId,
                    renglonId: renglon.id,
                    cantidad,
                    etiqueta: null,
                    ubicacionId: null,
                    usarEl: usarEl.trim().length === 0 ? null : usarEl,
                    clave,
                  });
                  if (r.ok) {
                    setSobra("");
                    setUsarEl("");
                    setAbierto(false);
                    claveSobra.current = null;
                  }
                  return r;
                });
              }}
            >
              Al refrigerador
            </Button>
          </div>
        )}

        {/*
          LA MERMA SE PREGUNTA, NO SE SUPONE. Mientras esta pantalla no la
          ofreciera, `renglon.botado` valía cero siempre y ese cero se usaba
          como dato duro para decidir cuánto más se puede guardar.
        */}
        {!abiertoBotar ? (
          <button
            type="button"
            className="min-h-[44px] font-body-sm text-body-sm text-primary underline"
            onClick={() => setAbiertoBotar(true)}
            disabled={pendiente || disponibleParaGuardar <= 0}
          >
            {disponibleParaGuardar <= 0
              ? "No queda nada por anotar de esta fuente"
              : "Se botó parte de esto"}
          </button>
        ) : (
          <div className="flex flex-wrap items-end gap-sm">
            <label className="min-w-[8rem] flex-1">
              <span className="font-body-sm text-body-sm text-on-surface-variant">
                Gramos que se botaron (hasta {formatearGramos(disponibleParaGuardar)})
              </span>
              <input
                className={CAMPO}
                inputMode="decimal"
                value={botado}
                onChange={(e) => setBotado(e.target.value)}
                placeholder="300"
                disabled={pendiente}
              />
            </label>
            <label className="min-w-[9rem] flex-1">
              <span className="font-body-sm text-body-sm text-on-surface-variant">
                ¿Qué pasó? (opcional)
              </span>
              <input
                className={CAMPO}
                value={motivoBotado}
                onChange={(e) => setMotivoBotado(e.target.value)}
                placeholder="Se quemó, quedó al sol…"
                disabled={pendiente}
              />
            </label>
            <Button
              disabled={pendiente}
              onClick={() => {
                const cantidad = Number(botado.replace(",", "."));
                if (!Number.isFinite(cantidad) || cantidad <= 0) return;
                if (claveBotado.current === null) {
                  claveBotado.current = nuevaClaveDeIntento(globalThis.crypto);
                }
                const clave = claveBotado.current;
                onCorrer(async () => {
                  const r = await botarDelEvento({
                    eventoId,
                    renglonId: renglon.id,
                    cantidad,
                    motivo: motivoBotado.trim().length === 0 ? null : motivoBotado.trim(),
                    clave,
                  });
                  if (r.ok) {
                    setBotado("");
                    setMotivoBotado("");
                    setAbiertoBotar(false);
                    claveBotado.current = null;
                  }
                  return r;
                });
              }}
            >
              A la basura
            </Button>
          </div>
        )}

        {/*
          ANULAR EXISTE PORQUE "18000" EN VEZ DE "1800" PASA. El motivo es
          obligatorio: sin él, mañana nadie sabe si esa comida no salió o si el
          número estaba mal. Los gramos vuelven al lote con un ajuste que lo
          dice.
        */}
        {!abiertoAnular ? (
          <button
            type="button"
            className="min-h-[44px] font-body-sm text-body-sm text-on-surface-variant underline"
            onClick={() => setAbiertoAnular(true)}
            disabled={pendiente}
          >
            Esto no fue así: anular el servido
          </button>
        ) : (
          <div className="flex flex-wrap items-end gap-sm">
            <label className="min-w-[10rem] flex-1">
              <span className="font-body-sm text-body-sm text-on-surface-variant">
                ¿Por qué lo anulas?
              </span>
              <input
                className={CAMPO}
                value={motivoAnular}
                onChange={(e) => setMotivoAnular(e.target.value)}
                placeholder="Me equivoqué de cantidad"
                disabled={pendiente}
              />
            </label>
            <Button
              disabled={pendiente || motivoAnular.trim().length === 0}
              onClick={() => {
                onCorrer(async () => {
                  const r = await anularServido({
                    eventoId,
                    renglonId: renglon.id,
                    motivo: motivoAnular.trim(),
                  });
                  if (r.ok) {
                    setMotivoAnular("");
                    setAbiertoAnular(false);
                  }
                  return r;
                });
              }}
            >
              Anular
            </Button>
          </div>
        )}
      </Card>
    </li>
  );
}
