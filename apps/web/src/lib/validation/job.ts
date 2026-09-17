import { z } from "zod";

import { platform } from "@/config/platform";
import { JobObjectiveType, JobUrgency } from "@/lib/domain/enums";

/**
 * Esquemas de validación del flujo "Publicar trabajo".
 *
 * Se validan por paso (para el asistente móvil) y como un todo antes de publicar.
 * El mismo esquema se reutiliza en cliente y servidor: una sola fuente de verdad.
 */

export const stepCategorySchema = z.object({
  categoryId: z.string().min(1, "Elige una categoría"),
});

export const stepLocationSchema = z.object({
  regionCode: z.string().min(1, "Selecciona una región"),
  communeCode: z.string().min(1, "Selecciona una comuna"),
  addressLine: z.string().min(5, "Ingresa una dirección válida").max(200),
  addressNotes: z.string().max(300).optional().or(z.literal("")),
  placeName: z.string().max(120).optional().or(z.literal("")),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
});

export const stepScheduleSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida"),
  time: z.string().regex(/^\d{2}:\d{2}$/, "Hora inválida"),
  durationMinutes: z
    .number()
    .int()
    .min(platform.minDurationMinutes, `La duración mínima es ${platform.minDurationMinutes} minutos`)
    .max(60 * 48, "Para más de 48 horas, divide el trabajo en tramos"),
});

export const stepDescriptionSchema = z.object({
  title: z.string().min(10, "El título necesita al menos 10 caracteres").max(120),
  description: z.string().min(30, "Describe el trabajo con al menos 30 caracteres").max(2000),
  instructions: z.string().max(2000).optional().or(z.literal("")),
  imageUrls: z.array(z.string().url()).max(6).default([]),
});

const objectiveBaseSchema = z.object({
  objectiveType: z.enum([
    JobObjectiveType.HOLD_PLACE,
    JobObjectiveType.AS_FRONT_AS_POSSIBLE,
    JobObjectiveType.WITHIN_FIRST_N,
    JobObjectiveType.COMPLETE_ERRAND,
    JobObjectiveType.CUSTOM,
  ]),
  targetPosition: z.number().int().min(1).max(5000).nullable().optional(),
  objectiveDescription: z.string().max(400).optional().or(z.literal("")),
  bonusAmount: z.number().int().min(0).max(5_000_000).nullable().optional(),
  bonusConditions: z.string().max(400).optional().or(z.literal("")),
});

export const stepObjectiveSchema = objectiveBaseSchema
  .refine(
    (v) => v.objectiveType !== JobObjectiveType.WITHIN_FIRST_N || Boolean(v.targetPosition),
    { message: "Indica dentro de cuántos lugares quieres quedar", path: ["targetPosition"] },
  )
  .refine(
    (v) => v.objectiveType !== JobObjectiveType.CUSTOM || Boolean(v.objectiveDescription),
    { message: "Describe el objetivo", path: ["objectiveDescription"] },
  )
  .refine((v) => !v.bonusAmount || v.bonusAmount === 0 || Boolean(v.bonusConditions), {
    message: "Explica en qué condición se paga el bono",
    path: ["bonusConditions"],
  });

export const stepPriceSchema = z.object({
  hourlyRate: z
    .number()
    .int("El monto debe ser un número entero en pesos")
    .min(3_000, "La tarifa por hora parece demasiado baja")
    .max(500_000, "La tarifa por hora parece demasiado alta"),
  urgency: z.enum([JobUrgency.FLEXIBLE, JobUrgency.NORMAL, JobUrgency.URGENTE]),
});

export const publishJobSchema = stepCategorySchema
  .extend(stepLocationSchema.shape)
  .extend(stepScheduleSchema.shape)
  .extend(stepDescriptionSchema.shape)
  .extend(stepPriceSchema.shape)
  .extend(objectiveBaseSchema.shape)
  .extend({
    acceptsRules: z
      .boolean()
      .refine((v) => v, "Debes aceptar las reglas de uso para publicar"),
  });

export type PublishJobInput = z.infer<typeof publishJobSchema>;

export type JobDraft = Partial<PublishJobInput>;

/** Pasos del asistente, en orden. Un solo lugar define la secuencia. */
export const publishSteps = [
  { id: "categoria", title: "¿Qué necesitas?", schema: stepCategorySchema },
  { id: "lugar", title: "¿Dónde?", schema: stepLocationSchema },
  { id: "cuando", title: "¿Cuándo?", schema: stepScheduleSchema },
  { id: "descripcion", title: "Describe el trabajo", schema: stepDescriptionSchema },
  { id: "objetivo", title: "Objetivo", schema: stepObjectiveSchema },
  { id: "precio", title: "Precio", schema: stepPriceSchema },
  { id: "revision", title: "Revisión", schema: null },
] as const;

export type PublishStepId = (typeof publishSteps)[number]["id"];
