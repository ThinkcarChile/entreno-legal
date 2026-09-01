"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { MEAL_TYPE_LABELS, MEAL_TYPES, type MealType } from "@/domain/recipes/types";
import {
  Button,
  ButtonOutline,
  CAMPO,
  Card,
  Chip,
  EmptyState,
  ErrorNote,
  Flotante,
  Icon,
  Notice,
  Section,
  TextField,
  ToggleChip,
} from "@/components/ui";
import {
  ETIQUETAS_CLASE,
  ETIQUETAS_EXTENT,
  ETIQUETAS_ORIGEN,
  EXTENTS_DE_UN_TOQUE,
  puedeDarsePorComida,
  textoCantidad,
  type Extent,
} from "./extent";
import type { Declaracion, PorcionServida } from "./queries";
import {
  anularDeclaracion,
  corregirDeclaracion,
  darPorComido,
  declararLoServido,
  declararOtraComida,
  type ResultadoAccion,
} from "./actions";

/**
 * "Lo que comimos": la pantalla donde una familia declara la REALIDAD.
 *
 * Está pensada alrededor de lo que pasa la mayoría de los días: se comió lo que
 * salió al plato y nadie quiere llenar un formulario. Ese camino es UN toque.
 * El día que no fue así —comió la mitad, comió otra cosa, comió afuera— hay que
 * poder decirlo sin pesar nada, y por eso las respuestas son «casi todo», «la
 * mitad», «nada», «no sé». La cantidad exacta existe, pero es opcional y está
 * escondida detrás de un toque más: pedirla de frente empuja a inventarla.
 *
 * Lo que NO hace, y es deliberado:
 *   · no muestra un solo dato clínico (§44/§45) — ni un ícono, ni un contador;
 *   · no califica el día, no compara con la meta, no felicita ni reta. Anotar
 *     lo que se comió no puede volverse una prueba que se aprueba o se reprueba,
 *     porque ahí la gente empieza a anotar lo que queda bien.
 */

interface Miembro {
  id: string;
  nombre: string;
}

interface Marca {
  extent: Extent;
  /** Texto crudo del campo. Vacío = no escribió ningún número. */
  cantidad: string;
}

type Marcas = Record<string, Marca>;

/** Lo que se escribió en el campo, o `null` si no hay número que leer. */
function numeroDe(texto: string): number | null {
  const limpio = texto.trim().replace(",", ".");
  if (limpio === "") return null;
  const n = Number(limpio);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function etiquetaComida(mealType: MealType | null): string {
  return mealType === null ? "Comida" : MEAL_TYPE_LABELS[mealType];
}

export function ComiBoard({
  dia,
  hoy,
  ayer,
  porDeclarar,
  declarado,
  miembros,
  miMiembroId,
}: {
  dia: string;
  hoy: string;
  ayer: string;
  porDeclarar: PorcionServida[];
  declarado: Declaracion[];
  miembros: Miembro[];
  miMiembroId: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [abierto, setAbierto] = useState<string | null>(null);

  function run(accion: () => Promise<ResultadoAccion>, alTerminar?: () => void) {
    setError(null);
    setMensaje(null);
    startTransition(async () => {
      const r = await accion();
      if (!r.ok) {
        // El mensaje del servidor se muestra COMPLETO: los de la 0038 dicen qué
        // hacer, y cambiarlos por "algo salió mal" deja a la persona sin salida.
        setError(r.error ?? "No se pudo anotar.");
        return;
      }
      setMensaje(r.message ?? "Listo.");
      setAbierto(null);
      alTerminar?.();
      router.refresh();
    });
  }

  const nombreDe = (id: string) =>
    miembros.find((m) => m.id === id)?.nombre ?? "Integrante del hogar";

  return (
    <div className="space-y-lg">
      {mensaje && <Flotante tono="ok">{mensaje}</Flotante>}
      {error && <ErrorNote>{error}</ErrorNote>}

      <nav className="flex flex-wrap items-center gap-sm">
        <Link
          href="/comi"
          aria-current={dia === hoy ? "page" : undefined}
          className={`rounded-full px-3 py-1.5 font-label-md text-label-md ${
            dia === hoy
              ? "bg-primary font-semibold text-on-primary"
              : "border border-outline text-on-surface-variant"
          }`}
        >
          Hoy
        </Link>
        <Link
          href={`/comi?dia=${ayer}`}
          aria-current={dia === ayer ? "page" : undefined}
          className={`rounded-full px-3 py-1.5 font-label-md text-label-md ${
            dia === ayer
              ? "bg-primary font-semibold text-on-primary"
              : "border border-outline text-on-surface-variant"
          }`}
        >
          Ayer
        </Link>
        {dia !== hoy && dia !== ayer && <Chip icon="event">{dia}</Chip>}
      </nav>

      <Section
        title="Salió a la mesa"
        hint="Todavía nadie dijo qué pasó con esta comida. Que falte no significa que no se comió."
      >
        {porDeclarar.length === 0 ? (
          <EmptyState icon="restaurant">
            No hay porciones esperando. Cuando sirvas una comida desde la Semana, aparece acá.
          </EmptyState>
        ) : (
          <ul className="space-y-md">
            {porDeclarar.map((p) => (
              <PorcionPendiente
                key={p.id}
                porcion={p}
                nombre={nombreDe(p.memberId)}
                pending={pending}
                abierto={abierto === `declarar:${p.id}`}
                onAbrir={() =>
                  setAbierto(abierto === `declarar:${p.id}` ? null : `declarar:${p.id}`)
                }
                run={run}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Ya anotado"
        hint="Corregir no borra nada: la versión anterior queda en la historia."
      >
        {declarado.length === 0 ? (
          <EmptyState icon="edit_note">Todavía no hay nada anotado en este día.</EmptyState>
        ) : (
          <ul className="space-y-md">
            {declarado.map((d) => (
              <DeclaracionAnotada
                key={d.id}
                declaracion={d}
                nombre={nombreDe(d.memberId)}
                pending={pending}
                abierto={abierto}
                onAbrir={(clave) => setAbierto(abierto === clave ? null : clave)}
                run={run}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section title="Comió otra cosa" hint="Algo que no salió de la despensa, o comida de afuera.">
        <OtraComida
          dia={dia}
          miembros={miembros}
          miMiembroId={miMiembroId}
          pending={pending}
          run={run}
        />
      </Section>
    </div>
  );
}

/**
 * Una porción que salió a la mesa y todavía no tiene declaración.
 *
 * El botón grande es el camino de todos los días. Dice lo que hace —da por
 * comido— y admite en voz alta que es un supuesto: el motor adaptativo tiene
 * que poder distinguir "alguien lo declaró" de "nadie dijo nada y lo dimos por
 * hecho", y esa distinción empieza en el texto del botón.
 */
function PorcionPendiente({
  porcion,
  nombre,
  pending,
  abierto,
  onAbrir,
  run,
}: {
  porcion: PorcionServida;
  nombre: string;
  pending: boolean;
  abierto: boolean;
  onAbrir: () => void;
  run: (accion: () => Promise<ResultadoAccion>, alTerminar?: () => void) => void;
}) {
  const [marcas, setMarcas] = useState<Marcas>({});
  const [notas, setNotas] = useState("");
  // Una sola pregunta con un solo dueño (`puedeDarsePorComida`, extent.ts): la
  // pantalla mostraba el botón mirando SOLO la merma, y con la despensa sin
  // entregar nada el camino de un toque escribía un cero duro justo donde el
  // camino manual se niega a poner número. El aviso y el botón salen de la
  // misma respuesta, así que no pueden volver a contradecirse.
  const asumible = puedeDarsePorComida(porcion.renglones);

  return (
    <Card as="li" className="p-md">
      <header className="mb-sm flex flex-wrap items-center justify-between gap-sm">
        <div className="min-w-0">
          <p className="font-label-md text-label-md uppercase text-on-surface-variant">
            {etiquetaComida(porcion.mealType)}
          </p>
          <h3 className="font-headline-sm text-headline-sm text-on-surface">{nombre}</h3>
        </div>
        <Chip icon={porcion.desdeElPlan ? "event_note" : "restaurant"}>
          {porcion.desdeElPlan ? "del plan" : "servido suelto"}
        </Chip>
      </header>

      <ul className="mb-md space-y-1">
        {porcion.renglones.map((r) => (
          <li
            key={r.servingRecordItemId}
            className="flex flex-wrap items-baseline justify-between gap-x-md border-b border-outline-variant/40 py-1 last:border-0"
          >
            <span className="font-body-md text-body-md text-on-surface">{r.label}</span>
            <span className="font-body-sm text-body-sm text-on-surface-variant">
              salieron {r.entregado} {r.unidad === "G" ? "g" : r.unidad === "ML" ? "ml" : "u"}
            </span>
          </li>
        ))}
      </ul>

      {!asumible.puede && (
        <div className="mb-sm">
          <Notice icon={asumible.motivo === "MERMA_DECLARADA" ? "delete" : "info"}>
            {asumible.texto}
          </Notice>
        </div>
      )}

      <div className="flex flex-wrap gap-sm">
        {asumible.puede && (
          <Button disabled={pending} onClick={() => run(() => darPorComido(porcion.id))}>
            <Icon name="done_all" className="text-[18px]" />
            Se comió todo
          </Button>
        )}
        <ButtonOutline disabled={pending} onClick={onAbrir}>
          <Icon name="edit" className="text-[18px]" />
          Decir cuánto comió
        </ButtonOutline>
      </div>
      {asumible.puede && (
        <p className="mt-sm font-body-sm text-body-sm text-outline">
          «Se comió todo» queda anotado como supuesto, porque nadie miró plato por plato.
        </p>
      )}

      {abierto && (
        <div className="mt-md space-y-md rounded-2xl bg-surface-container-low p-md">
          <MarcadorRenglones
            renglones={porcion.renglones.map((r) => ({
              id: r.servingRecordItemId,
              label: r.label,
              detalle: `salieron ${r.entregado} ${
                r.unidad === "G" ? "g" : r.unidad === "ML" ? "ml" : "u"
              }`,
            }))}
            marcas={marcas}
            setMarcas={setMarcas}
            permiteExacta
            pending={pending}
          />
          <TextField
            label="¿Algo que anotar? (opcional)"
            value={notas}
            onChange={setNotas}
            placeholder="Se sirvió otra vez, no le gustó…"
            disabled={pending}
            multiline
          />
          <Button
            full
            disabled={pending}
            onClick={() =>
              run(() =>
                declararLoServido({
                  servingRecordId: porcion.id,
                  marcas: porcion.renglones.map((r) => {
                    const marca = marcas[r.servingRecordItemId];
                    return {
                      servingRecordItemId: r.servingRecordItemId,
                      extent: marca === undefined ? "UNKNOWN" : marca.extent,
                      cantidadExacta:
                        marca !== undefined && marca.extent === "EXACT"
                          ? numeroDe(marca.cantidad)
                          : null,
                    };
                  }),
                  notas: notas.trim() === "" ? null : notas.trim(),
                }),
              )
            }
          >
            Guardar lo que comió
          </Button>
          <p className="font-body-sm text-body-sm text-outline">
            Lo que no marques queda como «no sé», que no es lo mismo que «nada».
          </p>
        </div>
      )}
    </Card>
  );
}

/** Una anotación viva, con lo que dice y de dónde salió. */
function DeclaracionAnotada({
  declaracion,
  nombre,
  pending,
  abierto,
  onAbrir,
  run,
}: {
  declaracion: Declaracion;
  nombre: string;
  pending: boolean;
  abierto: string | null;
  onAbrir: (clave: string) => void;
  run: (accion: () => Promise<ResultadoAccion>, alTerminar?: () => void) => void;
}) {
  const [motivo, setMotivo] = useState("");
  const [motivoAnular, setMotivoAnular] = useState("");
  const [marcas, setMarcas] = useState<Marcas>(() => {
    const inicial: Marcas = {};
    for (const r of declaracion.renglones) {
      const clave = r.servingRecordItemId === null ? r.id : r.servingRecordItemId;
      inicial[clave] = {
        extent: r.extent,
        cantidad: r.quantity !== null && r.quantityIsDeclared ? String(r.quantity) : "",
      };
    }
    return inicial;
  });
  const [libres, setLibres] = useState(
    declaracion.renglones.map((r) => ({ label: r.label, extent: r.extent })),
  );
  // Fijo mientras esta tarjeta vive: reintentar la misma corrección devuelve la
  // que ya se hizo en vez de encadenar dos (`p_correction_id` de la 0038).
  const [correccionId] = useState(() => crypto.randomUUID());

  const esServida = declaracion.servingRecordId !== null;
  const claveCorregir = `corregir:${declaracion.id}`;
  const claveAnular = `anular:${declaracion.id}`;

  return (
    <Card as="li" className="p-md">
      <header className="mb-sm flex flex-wrap items-center justify-between gap-sm">
        <div className="min-w-0">
          <p className="font-label-md text-label-md uppercase text-on-surface-variant">
            {etiquetaComida(declaracion.mealType)}
          </p>
          <h3 className="font-headline-sm text-headline-sm text-on-surface">{nombre}</h3>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip icon="label">{ETIQUETAS_CLASE[declaracion.kind] ?? declaracion.kind}</Chip>
          {/* De dónde viene la afirmación. Un supuesto no puede verse igual que
              algo que una persona dijo: es la distinción que sostiene el eje. */}
          <Chip
            tono={declaracion.source === "ASSUMED_FROM_PLAN" ? "atencion" : "primario"}
            icon={declaracion.source === "ASSUMED_FROM_PLAN" ? "help" : "record_voice_over"}
          >
            {ETIQUETAS_ORIGEN[declaracion.source]}
          </Chip>
        </div>
      </header>

      <ul className="mb-sm space-y-1">
        {declaracion.renglones.map((r) => (
          <li
            key={r.id}
            className="flex flex-wrap items-baseline justify-between gap-x-md border-b border-outline-variant/40 py-1 last:border-0"
          >
            <span className="font-body-md text-body-md text-on-surface">{r.label}</span>
            <span className="font-body-sm text-body-sm text-on-surface-variant">
              {ETIQUETAS_EXTENT[r.extent]} ·{" "}
              {textoCantidad({
                extent: r.extent,
                quantity: r.quantity,
                unit: r.unit,
                quantityIsDeclared: r.quantityIsDeclared,
              })}
            </span>
          </li>
        ))}
      </ul>

      {declaracion.notes !== null && (
        <p className="mb-sm font-body-sm text-body-sm text-on-surface-variant">
          <Icon name="sticky_note_2" className="mr-1 align-middle text-[16px]" />
          {declaracion.notes}
        </p>
      )}
      {declaracion.correctionReason !== null && (
        <p className="mb-sm font-body-sm text-body-sm text-on-surface-variant">
          <Icon name="history" className="mr-1 align-middle text-[16px]" />
          Corregido: {declaracion.correctionReason}
        </p>
      )}

      <div className="flex flex-wrap gap-sm">
        <ButtonOutline disabled={pending} onClick={() => onAbrir(claveCorregir)}>
          <Icon name="edit" className="text-[18px]" />
          Corregir
        </ButtonOutline>
        <ButtonOutline disabled={pending} onClick={() => onAbrir(claveAnular)}>
          <Icon name="undo" className="text-[18px]" />
          Anular
        </ButtonOutline>
      </div>

      {abierto === claveCorregir && (
        <div className="mt-md space-y-md rounded-2xl bg-surface-container-low p-md">
          {esServida ? (
            <MarcadorRenglones
              renglones={declaracion.renglones.flatMap((r) =>
                r.servingRecordItemId === null
                  ? []
                  : [{ id: r.servingRecordItemId, label: r.label }],
              )}
              marcas={marcas}
              setMarcas={setMarcas}
              permiteExacta={false}
              pending={pending}
            />
          ) : (
            <RenglonesLibres renglones={libres} setRenglones={setLibres} pending={pending} />
          )}

          <TextField
            label="¿Por qué se corrige?"
            value={motivo}
            onChange={setMotivo}
            placeholder="Me equivoqué de integrante, en realidad comió la mitad…"
            hint="La 0038 lo exige: una corrección muda es historia borrada."
            disabled={pending}
          />
          <Button
            full
            disabled={pending || motivo.trim() === ""}
            onClick={() =>
              run(
                () =>
                  corregirDeclaracion({
                    logId: declaracion.id,
                    motivo: motivo.trim(),
                    correccionId,
                    contenido:
                      declaracion.servingRecordId === null
                        ? {
                            tipo: "LIBRE",
                            renglones: libres.filter((r) => r.label.trim() !== ""),
                          }
                        : {
                            tipo: "SERVIDO",
                            servingRecordId: declaracion.servingRecordId,
                            marcas: Object.entries(marcas).map(([id, m]) => ({
                              servingRecordItemId: id,
                              extent: m.extent,
                              cantidadExacta: m.extent === "EXACT" ? numeroDe(m.cantidad) : null,
                            })),
                          },
                  }),
                () => setMotivo(""),
              )
            }
          >
            Guardar la corrección
          </Button>
        </div>
      )}

      {abierto === claveAnular && (
        <div className="mt-md space-y-md rounded-2xl bg-surface-container-low p-md">
          <Notice icon="info">
            Anular es decir que esta anotación no debió existir. Si lo que pasó es que no comió,
            eso se dice corrigiendo y marcando «Nada».
          </Notice>
          <TextField
            label="¿Por qué se anula?"
            value={motivoAnular}
            onChange={setMotivoAnular}
            placeholder="Estaba anotado dos veces"
            disabled={pending}
          />
          <Button
            full
            disabled={pending || motivoAnular.trim() === ""}
            onClick={() =>
              run(
                () =>
                  anularDeclaracion({ logId: declaracion.id, motivo: motivoAnular.trim() }),
                () => setMotivoAnular(""),
              )
            }
          >
            Anular la anotación
          </Button>
        </div>
      )}
    </Card>
  );
}

/**
 * Las respuestas con el pulgar. La cantidad exacta NO es un botón más de la
 * fila: aparece solo cuando alguien la pide, porque ofrecerla al mismo nivel
 * que «la mitad» empuja a escribir un número que nadie midió.
 */
function MarcadorRenglones({
  renglones,
  marcas,
  setMarcas,
  permiteExacta,
  pending,
}: {
  renglones: { id: string; label: string; detalle?: string }[];
  marcas: Marcas;
  setMarcas: (m: Marcas) => void;
  permiteExacta: boolean;
  pending: boolean;
}) {
  function marcar(id: string, extent: Extent) {
    const previa = marcas[id];
    setMarcas({
      ...marcas,
      [id]: { extent, cantidad: previa === undefined ? "" : previa.cantidad },
    });
  }

  return (
    <ul className="space-y-md">
      {renglones.map((r) => {
        const marca = marcas[r.id];
        const extent = marca === undefined ? "UNKNOWN" : marca.extent;
        return (
          <li key={r.id} className="space-y-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-x-md">
              <span className="font-body-md text-body-md font-semibold text-on-surface">
                {r.label}
              </span>
              {r.detalle && (
                <span className="font-body-sm text-body-sm text-outline">{r.detalle}</span>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {EXTENTS_DE_UN_TOQUE.map((opcion) => (
                <ToggleChip
                  key={opcion}
                  activo={extent === opcion}
                  disabled={pending}
                  onClick={() => marcar(r.id, opcion)}
                >
                  {ETIQUETAS_EXTENT[opcion]}
                </ToggleChip>
              ))}
              {permiteExacta && (
                <ToggleChip
                  activo={extent === "EXACT"}
                  disabled={pending}
                  title="Solo si de verdad lo pesaste"
                  onClick={() => marcar(r.id, "EXACT")}
                >
                  <Icon name="scale" className="text-[14px]" />
                  {ETIQUETAS_EXTENT.EXACT}
                </ToggleChip>
              )}
            </div>
            {extent === "EXACT" && (
              <TextField
                label={`¿Cuánto comió de ${r.label}?`}
                value={marca === undefined ? "" : marca.cantidad}
                onChange={(valor) =>
                  setMarcas({ ...marcas, [r.id]: { extent: "EXACT", cantidad: valor } })
                }
                hint="En la misma unidad en que salió al plato."
                inputMode="decimal"
                disabled={pending}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Renglones de algo que no salió de la despensa: nombre y cuánto, nada más. */
function RenglonesLibres({
  renglones,
  setRenglones,
  pending,
}: {
  renglones: { label: string; extent: Extent }[];
  setRenglones: (r: { label: string; extent: Extent }[]) => void;
  pending: boolean;
}) {
  function cambiar(i: number, cambio: Partial<{ label: string; extent: Extent }>) {
    setRenglones(renglones.map((r, j) => (i === j ? { ...r, ...cambio } : r)));
  }

  return (
    <div className="space-y-md">
      {renglones.map((r, i) => (
        <div key={i} className="space-y-sm">
          <TextField
            label={`¿Qué comió? (${i + 1})`}
            value={r.label}
            onChange={(valor) => cambiar(i, { label: valor })}
            placeholder="Torta de cumpleaños"
            disabled={pending}
          />
          <div className="flex flex-wrap gap-1.5">
            {EXTENTS_DE_UN_TOQUE.map((opcion) => (
              <ToggleChip
                key={opcion}
                activo={r.extent === opcion}
                disabled={pending}
                onClick={() => cambiar(i, { extent: opcion })}
              >
                {ETIQUETAS_EXTENT[opcion]}
              </ToggleChip>
            ))}
          </div>
        </div>
      ))}
      <ButtonOutline
        disabled={pending}
        onClick={() => setRenglones([...renglones, { label: "", extent: "UNKNOWN" }])}
      >
        <Icon name="add" className="text-[18px]" />
        Agregar otra cosa
      </ButtonOutline>
      <p className="font-body-sm text-body-sm text-outline">
        Acá no se piden gramos: de una comida de afuera nadie sabe si eran crudos o cocidos, y un
        número inventado es peor que decir «no sé».
      </p>
    </div>
  );
}

/** Comió algo que no salió de la despensa, en casa o afuera. */
function OtraComida({
  dia,
  miembros,
  miMiembroId,
  pending,
  run,
}: {
  dia: string;
  miembros: Miembro[];
  miMiembroId: string | null;
  pending: boolean;
  run: (accion: () => Promise<ResultadoAccion>, alTerminar?: () => void) => void;
}) {
  const [abierto, setAbierto] = useState(false);
  const [memberId, setMemberId] = useState(miMiembroId ?? miembros[0]?.id ?? "");
  const [donde, setDonde] = useState<"CASA" | "AFUERA">("AFUERA");
  const [mealType, setMealType] = useState<MealType | "">("");
  const [renglones, setRenglones] = useState<{ label: string; extent: Extent }[]>([
    { label: "", extent: "UNKNOWN" },
  ]);
  const [notas, setNotas] = useState("");

  if (miembros.length === 0) {
    return <EmptyState icon="group_add">Primero agrega integrantes al hogar.</EmptyState>;
  }

  if (!abierto) {
    return (
      <Card className="border border-dashed border-outline p-md">
        <button
          type="button"
          onClick={() => setAbierto(true)}
          className="flex w-full items-center justify-center gap-sm rounded-2xl px-md py-sm font-body-md text-body-md font-semibold text-primary transition-transform active:scale-[0.99]"
        >
          <Icon name="add" className="text-[20px]" />
          Anotar otra comida
        </button>
      </Card>
    );
  }

  return (
    <Card className="space-y-md p-md">
      <label className="block">
        <span className="font-body-sm text-body-sm text-on-surface-variant">¿Quién comió?</span>
        <select
          value={memberId}
          onChange={(e) => setMemberId(e.target.value)}
          className={`${CAMPO} mt-1`}
        >
          {miembros.map((m) => (
            <option key={m.id} value={m.id}>
              {m.nombre}
            </option>
          ))}
        </select>
      </label>

      <div>
        <p className="font-body-sm text-body-sm text-on-surface-variant">¿Dónde comió?</p>
        <div className="mt-1 flex flex-wrap gap-1.5">
          <ToggleChip activo={donde === "AFUERA"} disabled={pending} onClick={() => setDonde("AFUERA")}>
            Fuera de casa
          </ToggleChip>
          <ToggleChip activo={donde === "CASA"} disabled={pending} onClick={() => setDonde("CASA")}>
            En casa, pero no salió de la despensa
          </ToggleChip>
        </div>
        <p className="mt-1 font-body-sm text-body-sm text-outline">
          {donde === "AFUERA"
            ? "Cuenta para la alimentación; para la despensa no existe."
            : "La torta del cumpleaños, lo que trajo la vecina: no hay nada que reponer."}
        </p>
      </div>

      <label className="block">
        <span className="font-body-sm text-body-sm text-on-surface-variant">
          ¿Qué comida fue? (opcional)
        </span>
        <select
          value={mealType}
          onChange={(e) => setMealType(e.target.value === "" ? "" : (e.target.value as MealType))}
          className={`${CAMPO} mt-1`}
        >
          <option value="">Sin especificar</option>
          {MEAL_TYPES.map((m) => (
            <option key={m} value={m}>
              {MEAL_TYPE_LABELS[m]}
            </option>
          ))}
        </select>
      </label>

      <RenglonesLibres renglones={renglones} setRenglones={setRenglones} pending={pending} />

      <TextField
        label="¿Algo que anotar? (opcional)"
        value={notas}
        onChange={setNotas}
        placeholder="Almuerzo del trabajo"
        disabled={pending}
        multiline
      />

      <div className="flex flex-wrap gap-sm">
        <ButtonOutline disabled={pending} onClick={() => setAbierto(false)}>
          Cancelar
        </ButtonOutline>
        <Button
          className="flex-1"
          disabled={
            pending || memberId === "" || renglones.every((r) => r.label.trim() === "")
          }
          onClick={() =>
            run(
              () =>
                declararOtraComida({
                  memberId,
                  donde,
                  mealType: mealType === "" ? null : mealType,
                  dia,
                  renglones: renglones.filter((r) => r.label.trim() !== ""),
                  notas: notas.trim() === "" ? null : notas.trim(),
                }),
              () => {
                setRenglones([{ label: "", extent: "UNKNOWN" }]);
                setNotas("");
                setAbierto(false);
              },
            )
          }
        >
          Anotar lo que comió
        </Button>
      </div>
    </Card>
  );
}
