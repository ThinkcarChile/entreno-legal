-- 0051 — Consentimiento de IA a nivel HOGAR, revocable.
--
-- Hasta hoy el único consentimiento del proyecto es por documento de
-- laboratorio (`lab_documents.ai_consent_status`, 0026): se pide para UN
-- examen, para UNA extracción. El Sprint 15 manda por primera vez datos NO
-- clínicos del hogar —qué hay en la despensa, qué se planificó, qué se
-- compró— a un proveedor externo, y no hay dónde registrarlo ni cómo
-- revocarlo.
--
-- "El usuario aceptó los términos al registrarse" no sirve acá por dos
-- razones: el hogar tiene más de una persona (quien no aceptó nada igual
-- aparece en el plan que se manda) y un consentimiento que no se puede
-- revocar no es un consentimiento, es un aviso.
--
-- Dos ámbitos, porque son dos decisiones distintas y una no arrastra a la otra:
--   · ASSISTANT_HOUSEHOLD — lo operativo del hogar. Lo concede quien administra.
--   · ASSISTANT_CLINICAL  — lo que roza lo clínico, POR INTEGRANTE. Lo concede
--     el dueño de esos datos o quien tenga su grant. Que el hogar haya dicho
--     que sí al asistente no autoriza a nadie a mandar los exámenes de Ana.
--
-- Se guarda el `provider` y la `policy_version` porque un consentimiento sin
-- destinatario ni versión de política no responde la única pregunta que
-- después alguien va a hacer: "¿a quién dije que sí, y a qué?".

create type public.ai_consent_scope as enum (
  'ASSISTANT_HOUSEHOLD',
  'ASSISTANT_CLINICAL'
);

create table public.household_ai_consents (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references public.households (id) on delete cascade,
  scope          public.ai_consent_scope not null,
  -- NULL para el ámbito del hogar; obligatorio para el clínico.
  member_id      uuid references public.household_members (id) on delete cascade,
  provider       text not null check (char_length(provider) between 1 and 80),
  policy_version text not null check (char_length(policy_version) between 1 and 40),
  granted_by     uuid not null references public.household_members (id),
  granted_at     timestamptz not null default now(),
  revoked_at     timestamptz,
  revoked_by     uuid references public.household_members (id),
  constraint clinical_scope_needs_member
    check (scope <> 'ASSISTANT_CLINICAL' or member_id is not null),
  constraint household_scope_sin_member
    check (scope <> 'ASSISTANT_HOUSEHOLD' or member_id is null),
  constraint revocacion_completa
    check ((revoked_at is null) = (revoked_by is null))
);

-- Un consentimiento VIVO por (hogar, ámbito, integrante). La historia entera
-- queda: revocar no borra la fila, la cierra. `coalesce` sobre el uuid nulo
-- porque en un índice único dos NULL no chocan, y acá sí tienen que chocar.
create unique index household_ai_consents_vivo
  on public.household_ai_consents
     (household_id, scope, coalesce(member_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where revoked_at is null;

create index household_ai_consents_historia
  on public.household_ai_consents (household_id, scope, granted_at desc);

alter table public.household_ai_consents enable row level security;

-- Se lee en el hogar: saber si el asistente puede hablar con afuera no es un
-- secreto, es justo lo contrario.
create policy hh_ai_consents_select on public.household_ai_consents
  for select to authenticated using (app.is_household_member(household_id));

-- Escritura SOLO por el RPC. Una fila de consentimiento escrita por PostgREST
-- directo sería un consentimiento que se auto-otorga.
revoke insert, update, delete on public.household_ai_consents from anon, authenticated;

create or replace function public.set_assistant_consent(
  p_household      uuid,
  p_scope          public.ai_consent_scope,
  p_member         uuid,
  p_provider       text,
  p_policy_version text,
  p_granted        boolean
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_me uuid; v_id uuid;
begin
  if not app.is_household_member(p_household) then raise exception 'no autorizado'; end if;

  if p_scope = 'ASSISTANT_CLINICAL' then
    if p_member is null then
      raise exception 'el consentimiento clínico es de una persona: falta el integrante';
    end if;
    if app.member_household(p_member) is distinct from p_household then
      raise exception 'no autorizado';
    end if;
    -- Lo concede el DUEÑO de los datos, o quien mantiene una ficha sin cuenta
    -- (la guagua, el abuelo). Que alguien administre el hogar no lo hace dueño
    -- de los exámenes de otro.
    --
    -- Y NO alcanza con `medical_access(p_member,'READ_LABS')`, que era lo que
    -- decía antes: esa función incluye a los grantees, o sea que quien recibió
    -- "puedes leer mis exámenes" quedaba habilitado para autorizar que esos
    -- exámenes salieran a un proveedor externo. Leer y delegar son decisiones
    -- de distinta naturaleza, y la segunda el titular nunca la entregó. El
    -- helper que distingue las dos ya existe desde la 0026 y es este.
    if not app.can_manage_medical_grants(p_member) then raise exception 'no autorizado'; end if;
  else
    if p_member is not null then
      raise exception 'el consentimiento del hogar no es de una persona: sobra el integrante';
    end if;
    if not app.is_household_admin(p_household) then raise exception 'no autorizado'; end if;
  end if;

  v_me := app.current_member_id(p_household);
  if v_me is null then raise exception 'no autorizado'; end if;

  if p_granted then
    -- Se busca primero y se inserta después, a propósito: el índice único es
    -- PARCIAL y sobre una expresión, así que `on conflict` necesitaría repetir
    -- la expresión exacta. Un candado explícito sobre el hogar es más honesto
    -- que un `on conflict` que se rompe callado si alguien toca el índice.
    perform 1 from public.households where id = p_household for update;

    select id into v_id from public.household_ai_consents
     where household_id = p_household and scope = p_scope
       and member_id is not distinct from p_member and revoked_at is null;

    if v_id is null then
      insert into public.household_ai_consents
        (household_id, scope, member_id, provider, policy_version, granted_by)
      values (p_household, p_scope, p_member, p_provider, p_policy_version, v_me)
      returning id into v_id;
    end if;
  else
    update public.household_ai_consents
       set revoked_at = now(), revoked_by = v_me
     where household_id = p_household and scope = p_scope
       and member_id is not distinct from p_member and revoked_at is null
    returning id into v_id;

    -- Revocar algo que ya estaba revocado no es un error: es el mismo destino.
    -- Pero tampoco se finge que hubo cambio, y por eso el evento sólo sale
    -- cuando de verdad se cerró una fila.
    if v_id is null then return null; end if;
  end if;

  perform app.emit_event(
    p_household, 'ASSISTANT_CONSENT_CHANGED', v_id::text,
    jsonb_build_object('scope', p_scope, 'granted', p_granted, 'provider', p_provider),
    'ASSISTANT_CONSENT:' || v_id::text || ':' || case when p_granted then 'ON' else 'OFF' end);

  return v_id;
end;
$$;

comment on function public.set_assistant_consent(uuid, public.ai_consent_scope, uuid, text, text, boolean) is
  'Da o revoca el consentimiento de IA. El del hogar lo da quien administra; el '
  'clínico SÓLO el titular (o quien mantiene una ficha sin cuenta): tener el '
  'grant de lectura no es poder delegar. Revocar cierra la fila, no la borra.';

-- El predicado que van a mirar el router y el presupuesto. Un consentimiento
-- que hay que consultar en tres lugares distintos termina consultado en dos.
create or replace function app.assistant_consent_ok(
  p_household uuid,
  p_scope     public.ai_consent_scope,
  p_member    uuid default null
) returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.household_ai_consents
     where household_id = p_household and scope = p_scope
       and member_id is not distinct from p_member and revoked_at is null
  );
$$;

comment on function app.assistant_consent_ok(uuid, public.ai_consent_scope, uuid) is
  'Hay consentimiento VIVO. Sin esto, las capas que hablan con el proveedor no '
  'corren: el corte es un dato, no una advertencia en un comentario.';

-- ---------------------------------------------------------------------------
-- El consentimiento clínico, PUESTO donde se decide
-- ---------------------------------------------------------------------------
--
-- La 0050 declaró `app.assistant_clinical_consent_ok` devolviendo `false` para
-- que una base a medio migrar niegue lo clínico. Acá se reemplaza por la de
-- verdad, ahora que existe la tabla. La regla tiene UN dueño —esta migración—
-- y la 0050 sólo fija el default.
--
-- Los dos únicos lugares que la consultan son los dos por los que un dato
-- clínico puede entrar al asistente: `app.row_reachable` (el ámbito de un id
-- que el modelo nombró) y `app.assistant_capabilities` (lo que el actor puede
-- hacer con la ficha de otro). No hay un tercero, y ese es todo el punto: un
-- consentimiento que hay que acordarse de consultar es un consentimiento que
-- alguien va a olvidar.

create or replace function app.assistant_clinical_consent_ok(p_household uuid, p_member uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_member is not null
     and app.member_household(p_member) = p_household
     and app.assistant_consent_ok(p_household, 'ASSISTANT_CLINICAL', p_member);
$$;

comment on function app.assistant_clinical_consent_ok(uuid, uuid) is
  'La segunda llave de lo clínico: la del DUEÑO de los datos. Que el hogar haya '
  'dicho que sí al asistente no autoriza a nadie a mandar los exámenes de Ana.';
