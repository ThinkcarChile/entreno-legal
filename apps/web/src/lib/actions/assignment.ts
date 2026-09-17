"use server";

import { revalidatePath } from "next/cache";

import { AssignmentStatus } from "@/lib/domain/enums";
import { nextWorkerStep } from "@/lib/domain/job-actions";
import { actionError, actionOk, type ActionResult } from "@/lib/utils/errors";

import { requireSession } from "./guards";

/**
 * Avance del trabajo asignado.
 *
 * La transición se valida aquí contra la máquina de estados y otra vez en la
 * base: un trigger impide avanzar sin pago confirmado, y RLS impide que alguien
 * que no participa toque la asignación.
 */
export async function advanceAssignmentAction(
  assignmentId: string,
  to: AssignmentStatus,
): Promise<ActionResult<void>> {
  try {
    const { supabase, userId } = await requireSession();

    const { data: assignment } = await supabase
      .from("assignments")
      .select("id,status,worker_id,job_id")
      .eq("id", assignmentId)
      .maybeSingle<{ id: string; status: string; worker_id: string; job_id: string }>();

    if (!assignment) return { ok: false, error: "No encontramos el trabajo." };
    if (assignment.worker_id !== userId) {
      return { ok: false, error: "Solo el trabajador asignado puede avanzar el estado." };
    }

    const step = nextWorkerStep(assignment.status as AssignmentStatus);
    if (!step || step.to !== to) {
      return { ok: false, error: "Ese cambio de estado no corresponde ahora." };
    }

    const patch: Record<string, unknown> = { status: to };
    if (to === AssignmentStatus.CHECKED_IN) patch.checked_in_at = new Date().toISOString();
    if (to === AssignmentStatus.IN_PROGRESS) patch.started_at = new Date().toISOString();

    const { error } = await supabase.from("assignments").update(patch).eq("id", assignmentId);
    if (error) return actionError(error, "No pudimos actualizar el estado del trabajo.");

    // Cada avance deja rastro en la línea de tiempo del trabajo.
    await supabase.from("job_evidence").insert({
      job_id: assignment.job_id,
      assignment_id: assignmentId,
      author_id: userId,
      evidence_type: to === AssignmentStatus.CHECKED_IN ? "CHECK_IN" : "SYSTEM",
      title: step.label,
      body: step.description,
    });

    revalidatePath(`/mis-trabajos/${assignmentId}`);
    return actionOk();
  } catch (error) {
    return actionError(error, "No pudimos actualizar el estado del trabajo.");
  }
}
