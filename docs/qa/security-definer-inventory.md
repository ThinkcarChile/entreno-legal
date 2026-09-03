# Inventario de funciones SECURITY DEFINER (§48)

Medido, no supuesto. Se levanta la cadena completa del repo en PGlite
(`levantarBase()`, las 59 migraciones de `web/src/integration/harness.ts`) y se
lee el catálogo: `pg_proc.prosecdef`, `pg_proc.proconfig` para el
`search_path`, `has_function_privilege` para quien puede ejecutar y
`pg_get_functiondef` para el cuerpo. Las respuestas de "valida actor", "valida
hogar" y "sin oráculo" salen de leer ese cuerpo Y el de las funciones que
llama, hasta tres saltos: nueve funciones de `public` no comprueban nada por sí
mismas porque delegan entero en otra (`assistant_capabilities` en su gemela de
`app`, `consume_planned_meal` en `serve_meal_assignment`, `inbox_badge` en
`inbox_abiertos`), y mirarles solo el cuerpo de arriba las clasificaría mal.

Se regenera con el script del cierre v1 (queda en el scratchpad de la corrida) o
a mano, con la consulta de arriba, contra una base levantada con el arnés.

## Lo que hay

| | `public` | `app` | total |
|---|---:|---:|---:|
| funciones SECURITY DEFINER | 134 | 135 | 269 |
| sin `search_path` fijado | 0 | 0 | 0 |
| ejecutables por `anon` ANTES de la 0062 | 133 | 129 | 262 |
| ejecutables por `anon` DESPUÉS de la 0062 | 0 | 0 | 0 |
| ejecutables por `authenticated` (sin cambio) | 133 | 129 | 262 |

El `search_path` estaba bien en las 269: eso no es mérito de este cierre, es que
ya venía bien y hay que decirlo igual, porque un inventario que solo nombra lo
roto no sirve para saber que se revisó.

Las 262 abiertas a `anon` no las abrió nadie: PostgreSQL le da EXECUTE a PUBLIC
por defecto a toda función nueva, y anon está dentro de PUBLIC. Es la misma
puerta que la 0060 cerró para `purge_assistant_conversations` de a una. Ninguna
de las 133 de `public` entregaba datos a un anónimo —todas terminan preguntando
por `auth.uid()` y contra un JWT ausente eso es `null`, así que niegan— pero
antes de la 0062 anon sí podía leer la diferencia entre "no existe" y "no es
tuyo" en las doce del oráculo. La superficie se cierra igual: que una puerta
tenga cerradura no es razón para dejarla abierta.

## Clasificación de `public`

- **OK** — valida actor y hogar, y su error no distingue existir de pertenecer.
- **CERRAR_EXECUTE_ANON** — igual que OK, pero `anon` la podía ejecutar. La 0062
  le quitó el EXECUTE a PUBLIC y a anon; `authenticated` quedó igual que estaba.
- **ORACULO_CERRADO** — distinguía "no existe" de "no es tuyo". La 0062 unificó.
- **SOLO_DUENO** — ningún rol de la app la puede ejecutar; la corre postgres o
  un job con service_role. No necesita validar actor porque no tiene actor.
- **ORACULO** — todavía responde la existencia antes que la pertenencia.
  Tiene que quedar en CERO, y queda.
- **REVISAR** — no se le encontró ninguna comprobación de actor. Tiene que
  quedar en CERO, y queda.

- CERRAR_EXECUTE_ANON: 122
- ORACULO_CERRADO: 11
- SOLO_DUENO: 1

## `public` — 134 funciones

Columnas: `search_path` | quien podía ejecutar ANTES de la 0062 | quien puede
DESPUÉS | valida actor | valida hogar del recurso | "no existe" y "no es tuyo"
se responden igual | clasificación | la línea que lo justifica.

| función | search_path | EXECUTE antes | EXECUTE después | actor | hogar | sin oráculo | clase | justificación |
|---|---|---|---|---|---|---|---|---|
| `accept_invitation` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | NO | sí | CERRAR_EXECUTE_ANON | `if auth.uid() is null then` |
| `acknowledge_receipt_duplicate` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_d.id is null or not app.finance_access(v_d.household_id,…` |
| `add_manual_lot` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.is_household_member(p_household_id) then raise exc…` |
| `adjust_lot` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_lot.id is null or not app.is_household_member(v_lot.hous…` |
| `advance_procurement_order` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_household is null or not app.can_manage_shopping(v_house…` |
| `apply_clinical_shopping_delta` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | ORACULO_CERRADO | la 0062 desempató devolvía el `status` de una revisión clínica ajena, sin error ninguno |
| `archive_lab_document` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_doc.id is null or not app.medical_access(v_doc.member_id…` |
| `archive_purchase_receipt` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_d.id is null or not app.finance_access(v_d.household_id,…` |
| `assistant_breaker_probe` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.is_household_member(p_household) then raise except…` |
| `assistant_breaker_report` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.is_household_member(p_household) then raise except…` |
| `assistant_budget_check` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.is_household_member(p_household) then raise except…` (en app.assistant_budget_check) |
| `assistant_capabilities` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `select case when not app.is_household_member(p_household)` (en app.assistant_capabilities) |
| `assistant_engine_stamps` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.is_household_member(p_household) then raise except…` |
| `assistant_row_stamps` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.is_household_member(p_household) then return false…` (en app.row_reachable) |
| `assistant_usage_settle` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | ORACULO_CERRADO | la 0062 desempató 'no hay reserva viva con esa traza' / 'no autorizado' |
| `assistant_usage_sweep` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.is_household_member(p_household) then raise except…` |
| `assume_intake_from_plan` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_rec.id is null or not app.is_household_member(v_rec.hous…` |
| `attach_receipt_to_purchase` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_d.id is null or not app.finance_access(v_d.household_id,…` |
| `cancel_prep_plan` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_household is null or not app.is_household_member(v_house…` |
| `clear_food_budget` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.finance_access(p_household, 'FINANCE_MANAGE_BUDGET…` |
| `clear_substitution_choice` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_household is null or not app.is_household_member(v_house…` |
| `complete_prep_task` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.is_household_member(v_household) then raise except…` |
| `confirm_lab_extraction` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_doc.id is null or not app.medical_access(v_doc.member_id…` |
| `confirm_meal_assignment` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `and not (app.can_edit_plan(v_household) or app.can_cook(v_hou…` |
| `confirm_receipt_extraction` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_d.id is null or not app.finance_access(v_d.household_id,…` |
| `consume_planned_meal` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_household is not null and not app.can_cook(v_household) …` (en public.serve_meal_assignment) |
| `correct_intake_log` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_old.id is null or not app.is_household_member(v_old.hous…` |
| `correct_lab_observation` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_obs.id is null or not app.medical_access(v_obs.member_id…` |
| `correct_price_observation` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_o.id is null or not app.finance_access(v_o.household_id,…` |
| `correct_serving_item` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_rec.id is null or not app.is_household_member(v_rec.hous…` |
| `create_adaptive_review` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.can_access_member(p_member_id) then` |
| `create_assistant_proposal` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.is_household_member(p_household) then raise except…` |
| `create_clinical_impact_review` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.medical_access(p_member_id, 'VIEW_CLINICAL_RESTRIC…` |
| `create_clinical_restriction` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.medical_access(p_member_id, 'MANAGE_CLINICAL_RESTR…` |
| `create_clinical_rule_version` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | NO | sí | CERRAR_EXECUTE_ANON | `where user_id = auth.uid() and is_active order by created_at …` |
| `create_draft_from_version` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | ORACULO_CERRADO | la 0062 desempató 'versión inexistente' / 'no autorizado' |
| `create_household` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | NO | sí | CERRAR_EXECUTE_ANON | `if auth.uid() is null then` |
| `create_label_job` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_lot.id is null or not app.is_household_member(v_lot.hous…` |
| `create_meal_template` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.is_household_member(p_household_id) then` |
| `create_procurement_order` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.can_manage_shopping(p_household_id) then raise exc…` |
| `delete_receipt_file` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_d.id is null or not app.is_household_admin(v_d.household…` |
| `delete_stock_target` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.is_household_member(p_household_id) then raise exc…` |
| `discard_event_serving` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `v_actor := app.current_member_id(v_record.household_id);` |
| `discard_lot` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_lot.id is null or not app.is_household_member(v_lot.hous…` |
| `discard_serving` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_rec.id is null or not app.is_household_member(v_rec.hous…` |
| `duplicate_meal_template` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.is_household_member(p_household_id) then raise exc…` |
| `ensure_lot_token` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_lot.id is null or not app.is_household_member(v_lot.hous…` |
| `ensure_storage_locations` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.is_household_member(p_household_id) then raise exc…` |
| `ensure_weekly_plan` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.is_household_member(p_household_id) then raise exc…` |
| `estimate_shopping_list_prices` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_household is null or not app.finance_access(v_household,…` |
| `event_menu_blocks` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | ORACULO_CERRADO | la 0062 desempató 'ese evento no existe' / 'este evento no es de tu hogar' |
| `expire_assistant_proposals` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.is_household_member(p_household) then raise except…` |
| `expire_inbox_items` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.is_household_member(p_household) then raise except…` |
| `expire_temporary_targets` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.is_household_member(p_household) then` |
| `finance_permissions` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `select jsonb_object_agg(p.permission::text, app.finance_acces…` |
| `find_purchase_receipt_by_hash` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.finance_access(p_household, 'FINANCE_UPLOAD_RECEIP…` |
| `generate_shopping_revision` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | ORACULO_CERRADO | la 0062 desempató 'lista inexistente' / 'no autorizado' |
| `grant_finance_access` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.is_household_admin(p_household) then` |
| `grant_medical_access` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.can_manage_medical_grants(p_owner_member) then` |
| `inbox_abiertos` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `and app.capabilities_ok(i.household_id, i.requires)` |
| `inbox_badge` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `and app.capabilities_ok(i.household_id, i.requires)` (en public.inbox_abiertos) |
| `log_assistant_call` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.is_household_member(p_household) then return; end …` |
| `log_assistant_execution` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.is_household_member(v_row.household_id) then raise…` |
| `log_intake` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_rec.id is null or not app.is_household_member(v_rec.hous…` |
| `log_intake_away` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_household is null or not app.is_household_member(v_house…` (en app.create_unplanned_intake) |
| `log_intake_off_plan` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_household is null or not app.is_household_member(v_house…` (en app.create_unplanned_intake) |
| `log_medical_url_emission` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.medical_access(v_member, 'READ_LABS') then raise e…` |
| `mark_label_job` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_job.id is null or not app.is_household_member(v_job.hous…` |
| `meal_participants` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_household is null or not app.is_household_member(v_house…` |
| `merge_lots` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_lot.id is null or not app.is_household_member(v_lot.hous…` |
| `move_lot` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_lot.id is null or not app.is_household_member(v_lot.hous…` |
| `publish_clinical_rule_version` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_hogar is null or not app.is_household_member(v_hogar) th…` |
| `publish_meal_template_version` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `published_by = app.current_member_id(v_household)` |
| `publish_nutrition_profile` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.can_access_member(p_member_id) then` |
| `purge_assistant_conversations` | public | solo el dueño | solo el dueño | NO | NO | sí | SOLO_DUENO | no la puede ejecutar ningún rol de la app: la corre postgres o un job con service_role |
| `purge_assistant_proposals` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.is_household_admin(p_household) then raise excepti…` |
| `receipt_confirm_blocks` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_hogar is null or not app.finance_access(v_hogar, 'FINANC…` |
| `receive_procurement_order` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_order.id is null or not app.can_manage_shopping(v_order.…` |
| `receive_shopping_list` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_household is null or not app.can_manage_shopping(v_house…` |
| `reconcile_purchase` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | ORACULO_CERRADO | la 0062 desempató 'la compra no existe' (check_violation) / 'no autorizado' |
| `record_event_attendance` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | ORACULO_CERRADO | la 0062 desempató 'participante inexistente' / 'no puedes marcar asistencia en este hogar' |
| `record_event_consumption` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `v_actor := app.current_member_id(v_evento.household_id);` |
| `record_event_guest_observation` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | ORACULO_CERRADO | la 0062 desempató 'participante inexistente' / lo que dijera app.event_actual_gate |
| `record_price_sighting` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.finance_access(p_household, 'FINANCE_MANAGE_PRICES…` |
| `record_purchase` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.finance_access(p_household, 'FINANCE_CONFIRM_RECEI…` |
| `register_proposal_token` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.capabilities_ok(v_row.household_id, v_row.requires…` |
| `replace_draft_content` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `and app.is_household_member(t.household_id)` (en app.can_write_version) |
| `resolve_adaptive_review` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_r.id is null or not app.can_access_member(v_r.member_id)…` |
| `resolve_clinical_impact_review` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_r.id is null or not app.medical_access(v_r.member_id, 'V…` |
| `resolve_inbox_item` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.capabilities_ok(v_row.household_id, v_row.requires…` |
| `resolve_lot_token` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_lot.id is null or not app.is_household_member(v_lot.hous…` |
| `resolve_shortfall` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_household is null or not app.is_household_member(v_house…` |
| `return_serving_to_inventory` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_household is null or not app.is_household_member(v_house…` |
| `revoke_finance_access` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_g.id is null or not app.is_household_admin(v_g.household…` |
| `revoke_medical_access` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_grant.id is null or not app.can_manage_medical_grants(v_…` |
| `revoke_receipt_ai_consent` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_d.id is null or not app.finance_access(v_d.household_id,…` |
| `save_event_estimate_revision` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | ORACULO_CERRADO | la 0062 desempató 'evento inexistente' / 'no puedes editar el plan de este hogar' |
| `save_event_leftover` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `v_actor := app.current_member_id(v_record.household_id);` |
| `save_meal_clinical_assessment` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.medical_access(p_member_id, 'VIEW_CLINICAL_RESTRIC…` |
| `save_prep_plan` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.is_household_member(p_household_id) then raise exc…` |
| `seed_demo_family_profiles` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.is_household_member(p_household_id) then` |
| `serve_event_item` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `v_actor := app.current_member_id(v_evento.household_id);` |
| `serve_meal_assignment` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_household is not null and not app.can_cook(v_household) …` |
| `serve_off_plan` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_household is not null and not app.can_cook(v_household) …` |
| `set_assistant_consent` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.is_household_member(p_household) then raise except…` |
| `set_clinical_restriction_status` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_r.id is null or not app.medical_access(v_r.member_id, 'M…` |
| `set_cooking_preference` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_household is null or not app.is_household_member(v_house…` |
| `set_event_status` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | ORACULO_CERRADO | la 0062 desempató 'evento inexistente' / 'no puedes editar el plan de este hogar' |
| `set_food_budget` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.finance_access(p_household, 'FINANCE_MANAGE_BUDGET…` |
| `set_intended_use` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_lot.id is null or not app.is_household_member(v_lot.hous…` |
| `set_lab_ai_consent` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_doc.id is null or not app.medical_access(v_doc.member_id…` |
| `set_lot_safety` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_lot.id is null or not app.is_household_member(v_lot.hous…` |
| `set_planned_quantity` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_household is null or not app.can_manage_shopping(v_house…` |
| `set_receipt_ai_consent` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_d.id is null or not app.finance_access(v_d.household_id,…` |
| `set_receipt_intent` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_d.id is null or not app.finance_access(v_d.household_id,…` |
| `set_serving_clinical_status` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.medical_access(v_p.member_id, 'VIEW_CLINICAL_RESTR…` |
| `set_stock_target` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.is_household_member(p_household_id) then raise exc…` |
| `set_substitution_choice` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_household is null or not app.is_household_member(v_house…` |
| `set_supplier_product_price` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | ORACULO_CERRADO | la 0062 desempató 'esa presentación no existe' / 'no autorizado' |
| `settle_assistant_proposal` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.capabilities_ok(v_row.household_id, v_row.requires…` |
| `skip_prep_task` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.is_household_member(v_household) then raise except…` |
| `split_lot` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_lot.id is null or not app.is_household_member(v_lot.hous…` |
| `submit_lab_extraction` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_doc.id is null or not app.medical_access(v_doc.member_id…` |
| `submit_receipt_extraction` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_d.id is null or not app.finance_access(v_d.household_id,…` |
| `take_assistant_proposal` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.capabilities_ok(v_row.household_id, v_row.requires…` |
| `unconfirm_meal_assignment` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `and not (app.can_edit_plan(v_household) or app.can_cook(v_hou…` |
| `undo_discard_serving` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_rec.id is null or not app.is_household_member(v_rec.hous…` |
| `upload_lab_document` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.medical_access(p_member_id, 'UPLOAD_LABS') then` |
| `upload_purchase_receipt` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.finance_access(p_household, 'FINANCE_UPLOAD_RECEIP…` |
| `upsert_inbox_item` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if not app.is_household_member(p_household) then raise except…` |
| `use_lot` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_household is null or not app.is_household_member(v_house…` |
| `void_event_serving_item` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `v_actor := app.current_member_id(v_record.household_id);` |
| `void_intake_log` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_log.id is null or not app.is_household_member(v_log.hous…` |
| `void_serving_record` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí | sí | sí | CERRAR_EXECUTE_ANON | `if v_rec.id is null or not app.is_household_member(v_rec.hous…` |

## `app` — 135 funciones

`app` es el esquema interior: nadie de afuera debería llamarlo. Sus funciones
las invocan las SECURITY DEFINER de `public` (que corren como el dueño, no como
quien llama) y las politicas de RLS de `authenticated`. Por eso acá no se pide
que cada una valide el actor: varias SON la validacion, y otras son aritmética
(`app.apportion`, `app.mul_div_round`) que no tiene actor que validar. Lo que
si se exige es que `anon` no llegue: la 0062 le quita el EXECUTE a las 135 y
además le revoca el USAGE sobre el esquema, para que las que se escriban mañana
no nazcan abiertas.

| función | search_path | EXECUTE antes | EXECUTE después | mira a auth.uid() |
|---|---|---|---|---|
| `adaptive_clinical_context` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `allocate_movement_cost` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `allocate_purchase_charges` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `allocate_purchase_expense` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `append_only_guard` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `apply_clinical_shopping_delta` | public | solo el dueño | solo el dueño | sí |
| `apply_event_meal_coverage` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `apply_movement_to_lot` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `assert_finance_integrity` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `assignment_household` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `assistant_budget_check` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `assistant_capabilities` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `assistant_clinical_consent_ok` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `assistant_consent_ok` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `basis_factor` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `can_access_member` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `can_cook` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `can_edit_plan` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `can_manage_medical_grants` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `can_manage_shopping` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `can_read_template` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `can_write_template` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `can_write_version` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `capabilities_ok` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `cerrar_grants_al_desactivar` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `check_group_invariant` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `check_serving_item_balance` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `claim_dedupe` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `clinical_restriction_closes_temporary_targets` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `confirm_meal_assignment` | public | solo el dueño | solo el dueño | sí |
| `create_unplanned_intake` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `current_member_id` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `day_household` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `declared_from_serving_item` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `emit_event` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `emit_purchase_price_observations` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `event_actual_gate` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `event_children_history_guard` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `event_covering_slot` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `event_created_effects` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `event_history_guard` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `event_household` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `event_participants_sync_members` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `event_plan_moved_effects` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `event_roster_is_the_owner` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `event_serving_item_is_history` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `event_status_effects` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `event_status_transition_guard` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `exigir_can_edit_evento` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `exigir_can_edit_plan` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `fefo_deduct_event_item` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `fefo_deduct_serving_item` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `finance_access` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `finance_audit` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `finance_member_access` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `flag_meals_on_event_change` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `freeze_clinical_ceiling` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `freeze_lot_currency` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `grant_lot_columns` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `guest_profile_delete_guard` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `had_clinical_ceiling` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `household_currency_is_frozen` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `household_today` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `ingredient_in_scope` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `intake_item_guard` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `invitation_member_same_household` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `is_household_admin` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `is_household_member` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `is_medical_tutor` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `is_self_member` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `lab_document_registrado` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `last_unit_price_minor` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `live_intake_by_key` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `meal_inherits_event_coverage` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `measure_in_scope` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `medical_access` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `member_gets_default_role` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `member_household` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `movement_eater_member` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `movement_owner_guard` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `nutrition_fact_in_scope` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `plan_household` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `prep_input_stamp` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `prep_plan_household` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `procurement_household` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `procurement_input_stamp` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `product_in_scope` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `projection_inherits_event_coverage` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `protect_historical_ingredient` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `protect_historical_product` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `protect_location_with_lots` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `protect_served_assignment` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `protect_served_projection` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `puede_editar_perfil` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `receipt_candidate_doubts` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `receipt_confirm_blocks` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `receipt_object_is_evidence` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `receive_lot_from_purchase` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `record_price_observation` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `refresh_event_meal_coverage` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `release_event_meal_coverage` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `reverse_serving_item` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `row_clinical_owner` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `row_reachable` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `row_scope` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `row_stamp` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `serve_meal_assignment` | public | solo el dueño | solo el dueño | sí |
| `serve_off_plan` | public | solo el dueño | solo el dueño | sí |
| `serving_clinical_ceiling` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `serving_clinical_constraints` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `serving_clinical_context_member_guard` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `serving_item_guard` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `serving_record_has_active_intake` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `set_lot_value` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `settle_dedupe` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `shopping_household` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `slot_template` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `slot_version` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `stamp_observed_yield` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `stamp_shopping_item` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `stamp_shopping_override` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `stock_input_stamp` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `supplier_price_solo_por_rpc` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | sí |
| `sync_event_nutrition_members` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `template_household` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `unconfirm_meal_assignment` | public | solo el dueño | solo el dueño | sí |
| `use_lot` | public | solo el dueño | solo el dueño | sí |
| `validate_prep_preference_scope` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `validate_purchase_policy_scope` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `validate_supplier_product_scope` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `value_lot_from_purchase_item` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `verify_lot_cost_invariant` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `version_household` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `version_in_scope` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |
| `write_intake_items` | public | anon + authenticated + PUBLIC (por defecto) | authenticated | no (auxiliar interna) |

## Los doce oráculos, con el fragmento que los delataba

Comparar dos mensajes distintos es preguntarle a la base "¿existe este uuid?"
desde fuera de la casa. `gate-security.test.ts` ya vigilaba §38 —sin oráculo—
para `resolve_lot_token`, `use_lot` y `advance_procurement_order`; estas doce
se le escaparon porque nadie las había mirado con esa lupa.

- `app.event_actual_gate` — 'evento inexistente' (no_data_found) / 'te falta el permiso para cocinar o para planificar' (insufficient_privilege)
- `public.event_menu_blocks` — 'ese evento no existe' / 'este evento no es de tu hogar'
- `public.set_event_status` — 'evento inexistente' / 'no puedes editar el plan de este hogar'
- `public.save_event_estimate_revision` — 'evento inexistente' / 'no puedes editar el plan de este hogar'
- `public.record_event_attendance` — 'participante inexistente' / 'no puedes marcar asistencia en este hogar'
- `public.record_event_guest_observation` — 'participante inexistente' / lo que dijera app.event_actual_gate
- `public.create_draft_from_version` — 'versión inexistente' / 'no autorizado'
- `public.generate_shopping_revision` — 'lista inexistente' / 'no autorizado'
- `public.reconcile_purchase` — 'la compra no existe' (check_violation) / 'no autorizado'
- `public.set_supplier_product_price` — 'esa presentación no existe' / 'no autorizado'
- `public.assistant_usage_settle` — 'no hay reserva viva con esa traza' / 'no autorizado'
- `public.apply_clinical_shopping_delta` — devolvía el `status` de una revisión clínica ajena, sin error ninguno

El arreglo no fue borrar los mensajes útiles: fue preguntar primero
"¿pertenezco a este hogar?" —una sola respuesta para las dos formas de no
pertenecer— y recién después, ya adentro, decir con nombre y apellido qué rol
falta. Quien es de la casa sigue leyendo "te falta el permiso para planificar".

`public.apply_clinical_shopping_delta` no era un oráculo de existencia: DEVOLVÍA
el `status` de una revisión clínica de otro hogar que ya estuviera resuelta, sin
pasar por comprobación ninguna. Es la única de las doce que entregaba un dato, no
una diferencia entre dos errores.

## Lo que queda abierto (REVISAR, para después de v1)

1. **`authenticated` puede ejecutar las funciones de mantenimiento.**
   `expire_assistant_proposals`, `expire_inbox_items`, `expire_temporary_targets`,
   `purge_assistant_proposals`, `assistant_usage_sweep` y `assistant_breaker_probe`
   son barrenderos: cada una comprueba `app.is_household_member` (o
   `is_household_admin`) antes de tocar nada, así que nadie barre la casa ajena,
   pero cualquier integrante puede dispararlas cuando quiera. Cerrarlas a
   `authenticated` pide un corredor con `service_role` —un cron— que este repo
   todavía no tiene. La 0062 NO las cierra: cerrar la puerta antes de tener la
   llave es dejar la basura adentro.

2. **`seed_demo_family_profiles` sigue siendo ejecutable por `authenticated`.**
   La llama la app (`web/src/app/family/nutrition-actions.ts`) para armar la
   familia de demostración. Es escritura de datos de demo dentro del propio
   hogar; no se toca en v1, pero una instalación de producción no debería
   tenerla expuesta.

3. **El oráculo se cierra función por función, no por construcción.** No hay nada
   que impida que la función 270 nazca contestando 'x inexistente' antes de
   preguntar por el hogar. `cierre-seguridad.test.ts` toma cinco de muestra; una
   guarda que recorra los 134 cuerpos buscando ese patrón es trabajo de v2.
