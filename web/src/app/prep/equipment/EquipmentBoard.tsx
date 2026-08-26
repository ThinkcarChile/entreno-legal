"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { PrepPreference } from "@/domain/prep/types";
import { saveEquipment, saveEquipmentConfig, savePrepPreference } from "../actions";
import type { EquipmentView } from "../queries";
import { Button, ButtonOutline, Card, Chip, Flotante, Icon, Section } from "@/components/ui";

/**
 * Tablero de equipamiento: cada equipo con sus configuraciones declaradas
 * como datos (§10) y las preferencias de preparación por alimento (§11).
 * El motor solo sugiere lo que está acá — jamás inventa un corte (§12).
 */

/** Campo de formulario del kit: mismo alto de toque en todos lados. */
const FIELD =
  "w-full rounded-xl border border-outline-variant bg-surface-container-lowest px-md py-sm font-body-md text-body-md text-on-surface";


/** Etiqueta de campo: texto arriba, control abajo. */
function Campo({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`block font-body-sm text-body-sm text-on-surface-variant ${className}`}>
      {label}
      <span className="mt-1 block">{children}</span>
    </label>
  );
}

export function EquipmentBoard({
  equipment,
  preferences,
  ingredientes,
}: {
  equipment: EquipmentView[];
  preferences: PrepPreference[];
  ingredientes: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [nuevoNombre, setNuevoNombre] = useState("");
  const [abierto, setAbierto] = useState<string | null>(null);
  const [cCap, setCCap] = useState("CUT_SHRED");
  const [cTam, setCTam] = useState("");
  const [cTanda, setCTanda] = useState("");

  const [pIng, setPIng] = useState("");
  const [pTipo, setPTipo] = useState("SHRED");
  const [pTam, setPTam] = useState("");
  const [pCapId, setPCapId] = useState("");
  const [pManual, setPManual] = useState("");

  function run(
    action: () => Promise<{ ok: boolean; error?: string; message?: string }>,
    done?: () => void,
  ) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const r = await action();
      if (!r.ok) {
        setError(r.error ?? "No se pudo completar.");
        return;
      }
      if (r.message) setMessage(r.message);
      done?.();
      router.refresh();
    });
  }

  const todasConfigs = equipment.flatMap((e) => e.configs);

  return (
    <div>
      {message && <Flotante tono="ok">{message}</Flotante>}
      {error && <Flotante tono="error">{error}</Flotante>}

      {/* ---- Equipos ---- */}
      <Section title="Mi equipamiento" hint="Lo que hay en tu cocina, con sus configuraciones.">
        <ul className="grid gap-md md:grid-cols-2">
          {equipment.map((e) => (
            <li key={e.id}>
              <Card as="article" className="flex h-full flex-col p-md">
                <div className="flex flex-wrap items-start justify-between gap-sm">
                  <div className="flex min-w-0 items-center gap-sm">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-fixed text-on-primary-fixed">
                      <Icon name="blender" filled />
                    </span>
                    <h3 className="min-w-0 font-headline-sm text-headline-sm text-on-surface">
                      {e.name}
                    </h3>
                  </div>
                  <Chip
                    tono={e.isActive ? "primario" : "neutro"}
                    icon={e.isActive ? "check_circle" : "pause_circle"}
                  >
                    {e.isActive ? "Listo" : "Inactivo"}
                  </Chip>
                </div>

                {e.configs.length > 0 && (
                  <div className="mt-md">
                    <p className="font-label-md text-label-md uppercase text-on-surface-variant">
                      Configuraciones
                    </p>
                    <ul className="mt-sm flex flex-wrap gap-xs">
                      {e.configs.map((c) => (
                        <li key={c.id}>
                          <Chip>
                            {c.capability}
                            {(c.params as { size_mm?: number }).size_mm != null && (
                              <> {(c.params as { size_mm?: number }).size_mm} mm</>
                            )}
                            {c.maxBatchQuantity != null && <> · máx {c.maxBatchQuantity} g/tanda</>}
                          </Chip>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="mt-md flex flex-wrap gap-sm">
                  <ButtonOutline
                    disabled={pending}
                    onClick={() =>
                      run(() =>
                        saveEquipment({
                          id: e.id,
                          name: e.name,
                          notes: e.notes,
                          isActive: !e.isActive,
                        }),
                      )
                    }
                  >
                    {e.isActive ? "Desactivar" : "Activar"}
                  </ButtonOutline>
                  <ButtonOutline onClick={() => setAbierto(abierto === e.id ? null : e.id)}>
                    <Icon name={abierto === e.id ? "close" : "tune"} className="text-[18px]" />
                    {abierto === e.id ? "Cerrar" : "Agregar configuración"}
                  </ButtonOutline>
                </div>

                {abierto === e.id && (
                  <div className="mt-md grid gap-sm rounded-2xl bg-surface-container-low p-md sm:grid-cols-2">
                    <Campo label="Capacidad (código libre)">
                      <input
                        value={cCap}
                        onChange={(ev) => setCCap(ev.target.value)}
                        placeholder="CUT_SHRED"
                        className={FIELD}
                      />
                    </Campo>
                    <Campo label="Tamaño mm (opcional)">
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={cTam}
                        onChange={(ev) => setCTam(ev.target.value)}
                        className={FIELD}
                      />
                    </Campo>
                    <Campo label="Máx. por tanda en g (opcional)">
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={cTanda}
                        onChange={(ev) => setCTanda(ev.target.value)}
                        className={FIELD}
                      />
                    </Campo>
                    <div className="flex items-end">
                      <Button
                        disabled={pending}
                        onClick={() => {
                          if (
                            [cTam, cTanda].some((x) => x.trim() !== "" && !Number.isFinite(Number(x)))
                          ) {
                            setError("Revisa los números.");
                            return;
                          }
                          run(
                            () =>
                              saveEquipmentConfig({
                                equipmentId: e.id,
                                capability: cCap,
                                sizeMm: cTam.trim() === "" ? null : Number(cTam),
                                maxBatchQuantity: cTanda.trim() === "" ? null : Number(cTanda),
                              }),
                            () => {
                              setCTam("");
                              setCTanda("");
                            },
                          );
                        }}
                      >
                        Guardar
                      </Button>
                    </div>
                  </div>
                )}
              </Card>
            </li>
          ))}
        </ul>

        <Card className="mt-md border border-dashed border-outline-variant p-md">
          <p className="font-body-md text-body-md font-semibold text-on-surface">Nuevo equipo</p>
          <div className="mt-sm flex flex-wrap gap-sm">
            <input
              value={nuevoNombre}
              onChange={(e) => setNuevoNombre(e.target.value)}
              placeholder="Cortadora de verduras"
              className={`${FIELD} flex-1 basis-48`}
            />
            <Button
              disabled={pending || nuevoNombre.trim() === ""}
              onClick={() =>
                run(
                  () => saveEquipment({ name: nuevoNombre, notes: null, isActive: true }),
                  () => setNuevoNombre(""),
                )
              }
            >
              <Icon name="add" className="text-[18px]" />
              Agregar
            </Button>
          </div>
        </Card>
      </Section>

      {/* ---- Preferencias por alimento ---- */}
      <Section
        title="Cómo preparar cada alimento"
        hint="El motor SOLO sugiere cortes que tú declares acá — jamás inventa."
      >
        <Card className="p-md">
          {preferences.length > 0 && (
            <ul className="mb-md space-y-sm">
              {preferences.map((p) => (
                <li
                  key={p.ingredientId + p.taskType}
                  className="rounded-2xl bg-surface-container px-md py-sm font-body-sm text-body-sm text-on-surface-variant"
                >
                  <strong className="font-semibold text-on-surface">
                    {ingredientes.find((i) => i.id === p.ingredientId)?.name ?? "(alimento)"}
                  </strong>{" "}
                  — {p.taskType}
                  {(p.params as { size_mm?: number }).size_mm != null && (
                    <> {(p.params as { size_mm?: number }).size_mm} mm</>
                  )}
                  {p.manualAlternative && <> · manual: {p.manualAlternative}</>}
                </li>
              ))}
            </ul>
          )}

          <div className="grid gap-sm sm:grid-cols-2">
            <Campo label="Alimento">
              <select value={pIng} onChange={(e) => setPIng(e.target.value)} className={FIELD}>
                <option value="">Elige…</option>
                {ingredientes.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </Campo>
            <Campo label="Preparación">
              <select value={pTipo} onChange={(e) => setPTipo(e.target.value)} className={FIELD}>
                {["WASH", "PEEL", "TRIM", "CUT", "SHRED", "SLICE", "DICE"].map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Campo>
            <Campo label="Tamaño mm (opcional)">
              <input
                type="number"
                min="0"
                step="any"
                value={pTam}
                onChange={(e) => setPTam(e.target.value)}
                className={FIELD}
              />
            </Campo>
            <Campo label="Con el equipo (opcional)">
              <select value={pCapId} onChange={(e) => setPCapId(e.target.value)} className={FIELD}>
                <option value="">A mano</option>
                {todasConfigs.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.equipmentName}: {c.capability}
                    {(c.params as { size_mm?: number }).size_mm != null
                      ? ` ${(c.params as { size_mm?: number }).size_mm} mm`
                      : ""}
                  </option>
                ))}
              </select>
            </Campo>
            <Campo label="Alternativa manual (§12 — siempre existe)" className="sm:col-span-2">
              <input
                value={pManual}
                onChange={(e) => setPManual(e.target.value)}
                placeholder="rallador manual"
                className={FIELD}
              />
            </Campo>
          </div>

          <div className="mt-md">
            <Button
              full
              disabled={pending || pIng === ""}
              onClick={() => {
                if (pTam.trim() !== "" && !Number.isFinite(Number(pTam))) {
                  setError("Revisa el tamaño.");
                  return;
                }
                run(
                  () =>
                    savePrepPreference({
                      ingredientId: pIng,
                      taskType: pTipo,
                      sizeMm: pTam.trim() === "" ? null : Number(pTam),
                      capabilityId: pCapId || null,
                      manualAlternative: pManual || null,
                    }),
                  () => {
                    setPIng("");
                    setPTam("");
                    setPCapId("");
                    setPManual("");
                  },
                );
              }}
            >
              Guardar preferencia
            </Button>
          </div>
        </Card>
      </Section>
    </div>
  );
}
