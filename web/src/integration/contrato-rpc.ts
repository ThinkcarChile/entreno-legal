/**
 * EL CONTRATO DE RPC: qué es cada función que la aplicación puede llamar.
 *
 * UN SOLO DUEÑO. La lista la usan dos archivos de prueba —el que la valida
 * (`inventario-rpc.test.ts`) y el que ejecuta cada RPC de verdad
 * (`rpc-ejecucion.test.ts`)— y una lista copiada en dos lados se desincroniza el
 * día que alguien agrega una RPC en uno solo. Vive acá; allá se importa.
 *
 * Quién la hace cumplir: `inventario-rpc.test.ts` barre el código, arma el
 * inventario real y pone ROJO el CI si aparece una RPC que no está en este
 * archivo, o si este archivo clasifica una que la app ya no llama.
 */

export interface Clasificacion {
  /** Dónde corre la llamada. `cliente` significa que viaja al navegador. */
  lado: "servidor" | "cliente";
  /**
   * Con qué rol se espera que se ejecute.
   *
   * `servicio` es el rol de Postgres que se salta toda la RLS. Se nombra en
   * español a propósito: el guardián de credenciales de `lib/entorno.test.ts`
   * prohíbe su nombre en inglés dentro de `web/src`, y tiene razón en
   * prohibirlo. Que este archivo lo escribiera aunque fuera como nombre de tipo
   * ya le gastaba una alarma, y un guardián que acusa de más se termina
   * silenciando. Hoy ninguna RPC de la app usa este rol.
   */
  rol: "authenticated" | "servicio" | "interna";
  anonimo_permitido: boolean;
}

/**
 * La clasificación por omisión de este proyecto: server action o server
 * component, con sesión, jamás anónima. Las 84 caen acá — hoy.
 *
 * Se escribe como constante compartida y no como literal repetido 84 veces
 * porque lo que importa no es el valor sino que el NOMBRE esté enumerado: una
 * RPC nueva no aparece sola en esta lista, alguien la tiene que escribir. El día
 * que una necesite otra clasificación, se le pone su propio objeto y el guardián
 * obliga a justificarla contra los privilegios reales de la base.
 */
const S: Clasificacion = { lado: "servidor", rol: "authenticated", anonimo_permitido: false };

export const CONTRATO: Readonly<Record<string, Clasificacion>> = {
  "accept_invitation": S, "acknowledge_receipt_duplicate": S, "add_manual_lot": S,
  "adjust_lot": S, "advance_procurement_order": S, "archive_purchase_receipt": S,
  "assistant_capabilities": S, "assistant_engine_stamps": S, "assistant_row_stamps": S,
  "assume_intake_from_plan": S, "attach_receipt_to_purchase": S, "cancel_prep_plan": S,
  "clear_substitution_choice": S, "complete_prep_task": S, "confirm_lab_extraction": S,
  "confirm_meal_assignment": S, "confirm_receipt_extraction": S, "consume_planned_meal": S,
  "correct_intake_log": S, "correct_lab_observation": S, "create_clinical_impact_review": S,
  "create_clinical_restriction": S, "create_draft_from_version": S, "create_household": S,
  "create_label_job": S, "create_meal_template": S, "create_procurement_order": S,
  "delete_stock_target": S, "discard_event_serving": S, "discard_lot": S,
  "duplicate_meal_template": S, "ensure_storage_locations": S, "ensure_weekly_plan": S,
  "event_menu_blocks": S, "finance_permissions": S, "find_purchase_receipt_by_hash": S,
  "generate_shopping_revision": S, "grant_medical_access": S, "inbox_abiertos": S,
  "log_intake": S, "log_intake_away": S, "log_intake_off_plan": S,
  "mark_label_job": S, "move_lot": S, "publish_meal_template_version": S,
  "publish_nutrition_profile": S, "receipt_confirm_blocks": S, "receive_procurement_order": S,
  "receive_shopping_list": S, "record_event_attendance": S, "record_event_consumption": S,
  "record_event_guest_observation": S, "register_proposal_token": S, "replace_draft_content": S,
  "resolve_clinical_impact_review": S, "resolve_lot_token": S, "resolve_shortfall": S,
  "revoke_medical_access": S, "revoke_receipt_ai_consent": S, "save_event_estimate_revision": S,
  "save_event_leftover": S, "save_meal_clinical_assessment": S, "save_prep_plan": S,
  "seed_demo_family_profiles": S, "serve_event_item": S, "serve_meal_assignment": S,
  "set_clinical_restriction_status": S, "set_cooking_preference": S, "set_lab_ai_consent": S,
  "set_lot_safety": S, "set_planned_quantity": S, "set_receipt_ai_consent": S,
  "set_serving_clinical_status": S, "set_stock_target": S, "set_substitution_choice": S,
  "skip_prep_task": S, "submit_lab_extraction": S, "submit_receipt_extraction": S,
  "unconfirm_meal_assignment": S, "upload_lab_document": S, "upload_purchase_receipt": S,
  "use_lot": S, "void_event_serving_item": S, "void_intake_log": S,
};

/** Los nombres, para quien sólo necesita recorrerlos. */
export const CONTRATO_RPC: readonly string[] = Object.keys(CONTRATO).sort();
