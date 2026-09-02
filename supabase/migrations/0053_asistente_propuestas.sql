-- 0053 — `assistant_proposals`: la pieza que sostiene a todas las demás.
--
-- ---------------------------------------------------------------------------
-- EL CHAT NO ES EL BOTÓN
-- ---------------------------------------------------------------------------
--
-- Un asistente que puede EJECUTAR porque alguien se lo pidió en lenguaje
-- natural es un asistente que ejecuta lo que le pida cualquier texto que
-- alcance a leer: el nombre de un alimento, una boleta escaneada, la nota de
-- bodega que viene adentro de una receta. "El usuario ya autorizó" escrito en
-- una boleta se lee igual que escrito por el usuario.
--
-- La respuesta de este proyecto no es una instrucción en el prompt —el prompt
-- es prosa, y la prosa se puede convencer— sino un camino de código que no
-- existe. El asistente PROPONE: escribe una fila acá. Una persona CONFIRMA:
-- toca un control que el modelo no puede emitir. Sin fila no hay `proposalId`;
-- sin `proposalId` no hay nada sobre qué apoyar la compuerta.
--
-- Por eso esta migración es la primera del sprint que se construye y no la
-- última: `runActionTool` exige {proposalId, acceptedByMemberId,
-- confirmationToken} en su firma, y los tres salen de acá.
--
-- ---------------------------------------------------------------------------
-- LO QUE SE GUARDA Y LO QUE NO
-- ---------------------------------------------------------------------------
--
-- `basis` es LA FOTO: lo que se vio al proponer. No es autoridad de ninguna
-- clase — sirve para comparar contra la escena viva al aceptar, y si no calza,
-- la propuesta muere y nace otra. Una propuesta es una foto; la ejecución
-- exige la escena.
--
-- `resumen` es lo que se le mostró a la persona. Se congela por la misma razón
-- por la que un contrato se firma en papel: si al aceptar se recalculara, el
-- botón diría una cosa y el sistema haría otra.

create type public.assistant_proposal_status as enum (
  'OFFERED',              -- creada y mostrada
  'ACCEPTED',             -- TOMADA por una persona; revalidando. Es el estado EN VUELO
  'EXECUTED',             -- la acción existente devolvió ok
  'REJECTED',             -- descartada por una persona
  'EXPIRED',              -- pasó expires_at sin decisión
  'SUPERSEDED',           -- el estado cambió y nació otra propuesta
  'REVALIDATION_FAILED',  -- el estado cambió y no se pudo recalcular
  'FAILED',               -- la acción existente devolvió error, SIN escribir
  -- La acción se llamó y no sabemos si escribió (timeout, corte de red).
  --
  -- No es FAILED y la diferencia no es cosmética: decir "no se hizo" cuando
  -- pudo haberse hecho es la peor de las dos mentiras, porque el recibo miente
  -- y alguien repite a mano una escritura que ya ocurrió. ERROR != VACÍO también
  -- vale para las escrituras.
  --
  -- Faltaba: el dominio lo escribía (`run-tool.ts`, rama del catch) contra un
  -- enum que no lo tenía, así que contra Postgres esa escritura reventaba por
  -- valor inválido y la propuesta quedaba en ACCEPTED, sin recibo y sin rastro
  -- del único final que no se puede adivinar después.
  'EXECUTION_UNKNOWN'
);

-- NOTA DE VOCABULARIO: 'ACCEPTED' acá y 'ACCEPTING' en el dominio son EL MISMO
-- estado en vuelo, y la traducción vive en un solo borde
-- (`app/asistente/propuesta/queries.ts`). No se renombra ninguno de los dos
-- porque la 0054..0058 ya escriben 'ACCEPTED'.

create type public.assistant_risk as enum ('BAJO', 'MEDIO', 'ALTO');

-- De dónde salió la INTENCIÓN, que no es lo mismo que de dónde salió el texto.
--   USUARIO — lo pidió la persona en su turno. Sólo esto puede renderizarse
--             como tarjeta con botón.
--   MOTOR   — lo levantó un motor del dominio (stock, prep, seguridad) sin que
--             nadie lo pidiera. Va al inbox, nunca a un botón dentro del chat.
-- La distinción existe porque un turno que trae un bloque AJENO —una boleta,
-- una etiqueta, una receta de afuera— puede producir una propuesta
-- perfectamente bien formada cuya existencia decidió el atacante.
create type public.assistant_intent_origin as enum ('USUARIO', 'MOTOR');

create table public.assistant_proposals (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  created_by    uuid not null references public.household_members (id),
  trace_id      text not null check (char_length(trace_id) between 1 and 80),

  -- UNA sola acción existente. Nada de composición: el asistente no encadena
  -- escrituras para simular una transacción que la base no tiene.
  accion        text not null check (char_length(accion) between 1 and 80),
  args          jsonb not null,

  risk          public.assistant_risk not null,
  -- Vocabulario CERRADO, el mismo que declara `WriteEffect` en tool.ts. Antes
  -- era texto libre de 1 a 40 caracteres, y un efecto que la base no entiende
  -- es un efecto sobre el que la base no puede exigir nada: 'WRITES_CLINIC'
  -- mal escrito dejaba de ser clínico para todos los efectos.
  effect        text not null check (effect in (
                  'WRITES_PREFS', 'WRITES_PLAN', 'WRITES_LEDGER',
                  'WRITES_MONEY', 'WRITES_CLINICAL', 'WRITES_GRANTS')),
  origen        public.assistant_intent_origin not null,

  -- Qué capacidades hacen falta para VER y para ACEPTAR esta tarjeta. Se
  -- evalúa en la política de RLS, no en TypeScript: la audiencia escrita en la
  -- app es una sugerencia, la escrita en la política es el techo.
  requires      jsonb not null default '[]'::jsonb,

  -- Calculada AL CREAR, no al aceptar. Si se calculara al aceptar, dos clics
  -- sobre la misma tarjeta producirían dos claves distintas y el dedupe del
  -- RPC destino no serviría de nada.
  dedupe_key    text not null,

  basis         jsonb not null,
  resumen       jsonb not null,

  status        public.assistant_proposal_status not null default 'OFFERED',
  superseded_by uuid references public.assistant_proposals (id),
  decided_by    uuid references public.household_members (id),
  decided_at    timestamptz,
  -- Lo que devolvió la acción, para que EXECUTED no sea una palabra sin
  -- respaldo. Sólo ids y conteos: nunca el payload ni un valor clínico.
  resultado     jsonb,

  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,

  constraint dedupe_no_vacia check (char_length(btrim(dedupe_key)) > 0),
  constraint requires_es_lista check (jsonb_typeof(requires) = 'array'),
  -- La audiencia de una tarjeta clínica NO puede quedar en manos del
  -- `requires()` de la herramienta. La política de lectura es
  -- `capabilities_ok(household_id, requires)` y con la lista VACÍA eso
  -- significa "cualquiera de esta casa": un `requires()` olvidado en una
  -- herramienta clínica dejaba "Sodio · máx 1500 mg" legible por todo el hogar
  -- en /inbox y aceptable por cualquier integrante.
  --
  -- Va como CHECK de tabla y no como línea adentro del RPC por lo mismo que el
  -- trigger de inmutabilidad: los RPC son SECURITY DEFINER y el día que
  -- alguien escriba el sexto se va a olvidar. La 0056 ya tiene este piso para
  -- los avisos del inbox ("un aviso clínico sin integrante dueño no se puede
  -- mostrar a nadie"); acá faltaba.
  constraint clinico_nombra_su_audiencia check (
    effect not in ('WRITES_CLINICAL', 'WRITES_GRANTS')
    or requires @> '[{"k":"MEDICAL"}]'::jsonb
  ),
  -- El basis sin forma es una foto en blanco: se ve igual que una escena que
  -- no cambió, y ese parecido es exactamente el bug que se quiere evitar.
  constraint basis_tiene_forma check (basis ? 'capturedAt' and basis ? 'engineVersions'),
  constraint vence_despues_de_nacer check (expires_at > created_at)
);

-- Una sola propuesta VIVA por dedupe. Sin esto, preguntar tres veces lo mismo
-- crea tres filas y las tres caen al inbox: el modelo no crea avisos por la
-- puerta del frente, pero los crearía por la de atrás.
create unique index assistant_proposals_viva
  on public.assistant_proposals (household_id, dedupe_key) where status = 'OFFERED';

-- La única franja que el inbox y la aceptación consultan en caliente.
create index assistant_proposals_abiertas
  on public.assistant_proposals (household_id, expires_at)
  where status in ('OFFERED', 'ACCEPTED');

-- Para la purga y para el aviso "lo que te propuse ya no calza".
create index assistant_proposals_terminales
  on public.assistant_proposals (household_id, status, decided_at desc);

alter table public.assistant_proposals enable row level security;

-- ---------------------------------------------------------------------------
-- Quién LEE la tarjeta
-- ---------------------------------------------------------------------------
--
-- La respuesta fácil —"cualquier integrante del hogar"— es el default de casi
-- todas las tablas del proyecto y acá está mal. Una propuesta clínica guarda
-- en `resumen.lineas` cosas como "Sodio · máx 1500 mg" y en `basis.rows` ids
-- de restricciones. Con la política plana, el resumen de una propuesta clínica
-- queda legible por toda la casa ANTES de que nadie la acepte, y además
-- aparece en /inbox.
--
-- La política sale de `requires`, evaluado por la base (0050).
create policy assistant_proposals_select on public.assistant_proposals
  for select to authenticated
  using (app.capabilities_ok(household_id, requires));

revoke insert, update, delete on public.assistant_proposals from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Historia inmutable
-- ---------------------------------------------------------------------------
--
-- Una propuesta rechazada NO se borra: queda rechazada, con quién y cuándo. Y
-- lo que se mostró tampoco se puede reescribir después, porque entonces la
-- auditoría contaría la historia que convenga y no la que pasó.
--
-- Va como trigger y no como confianza en los RPC: los RPC son SECURITY
-- DEFINER, y el día que alguien escriba el sexto se va a olvidar.

create or replace function app.propuesta_inmutable()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    if new.household_id <> old.household_id
       or new.created_by <> old.created_by
       or new.trace_id   <> old.trace_id
       or new.accion     <> old.accion
       or new.args       <> old.args
       or new.risk       <> old.risk
       or new.effect     <> old.effect
       or new.origen     <> old.origen
       or new.requires   <> old.requires
       or new.dedupe_key <> old.dedupe_key
       or new.basis      <> old.basis
       or new.resumen    <> old.resumen
       or new.created_at <> old.created_at
       or new.expires_at <> old.expires_at then
      raise exception 'una propuesta no se reescribe: lo que se propuso es lo que se propuso'
        using errcode = 'check_violation';
    end if;

    -- Terminal es terminal. Sin esto, un reintento podría revivir una
    -- propuesta ya ejecutada y ejecutarla de nuevo.
    if old.status not in ('OFFERED', 'ACCEPTED') and new.status <> old.status then
      raise exception 'la propuesta ya está en % y ese estado es final', old.status
        using errcode = 'check_violation';
    end if;

    -- Un cierre sin firma no es historia, es un borrado con otra cara.
    if new.status <> old.status and new.status <> 'EXPIRED'
       and (new.decided_by is null or new.decided_at is null) then
      raise exception 'todo cierre lleva quién y cuándo: falta decided_by o decided_at'
        using errcode = 'check_violation';
    end if;

    return new;
  end if;

  -- DELETE: sólo la purga de retención, y sólo sobre lo ya terminado y viejo.
  --
  -- Excepción declarada: si el hogar ya no existe, esto es el `on delete
  -- cascade` limpiando atrás y no alguien borrando historia. Sin esta línea,
  -- borrar un hogar sería imposible mientras tuviera una propuesta abierta.
  if not exists (select 1 from public.households where id = old.household_id) then
    return old;
  end if;
  if old.status in ('OFFERED', 'ACCEPTED') then
    raise exception 'una propuesta viva no se borra: se rechaza, y queda'
      using errcode = 'check_violation';
  end if;
  if old.created_at > now() - interval '30 days' then
    raise exception 'la historia del asistente se guarda 30 días: esta propuesta todavía cuenta'
      using errcode = 'check_violation';
  end if;
  return old;
end;
$$;

create trigger assistant_proposals_inmutable
  before update or delete on public.assistant_proposals
  for each row execute function app.propuesta_inmutable();

comment on function app.propuesta_inmutable() is
  'La historia del asistente no se reescribe. Una rechazada queda rechazada con '
  'quién y cuándo; una ejecutada no puede volver a OFFERED; el texto que se le '
  'mostró a la persona no se edita después.';

-- ---------------------------------------------------------------------------
-- Crear
-- ---------------------------------------------------------------------------

-- Tope duro de propuestas vivas por hogar. Diez tarjetas abiertas ya no son un
-- centro de acciones: son una bandeja que nadie mira.
create or replace function app.tope_propuestas_vivas()
returns int language sql immutable as $$ select 20; $$;

create or replace function public.create_assistant_proposal(
  p_household    uuid,
  p_trace        text,
  p_accion       text,
  p_args         jsonb,
  p_risk         public.assistant_risk,
  p_effect       text,
  p_origen       public.assistant_intent_origin,
  p_requires     jsonb,
  p_dedupe       text,
  p_basis        jsonb,
  p_resumen      jsonb,
  p_ttl_minutes  int
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_me uuid; v_vivas int;
begin
  if not app.is_household_member(p_household) then raise exception 'no autorizado'; end if;

  -- La audiencia clínica, con nombre y apellido antes de que hable el CHECK.
  -- El constraint de la tabla es el piso —vale para cualquier RPC futuro— pero
  -- un `check_violation` no le dice a quien programa QUÉ le faltó.
  if p_effect in ('WRITES_CLINICAL', 'WRITES_GRANTS')
     and not (coalesce(p_requires, '[]'::jsonb) @> '[{"k":"MEDICAL"}]'::jsonb) then
    raise exception 'una propuesta % tiene que decir a quién afecta: falta la '
                    'capacidad MEDICAL en requires, y sin ella la tarjeta la '
                    've toda la casa', p_effect;
  end if;

  -- Y el integrante nombrado tiene que ser de esta casa. Un `owner` de otro
  -- hogar haría `capabilities_ok` false para todos —la tarjeta nacería
  -- invisible, ni siquiera para quien la propuso— y eso se vería igual que un
  -- permiso faltante. Dos causas distintas con la misma cara es justo lo que
  -- convierte un bug en un misterio.
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_requires, '[]'::jsonb)) c
     where c->>'k' = 'MEDICAL'
       and (c->>'owner' is null
            or c->>'owner' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            or app.member_household((c->>'owner')::uuid) is distinct from p_household)
  ) then
    raise exception 'la capacidad MEDICAL nombra a alguien que no es de esta casa';
  end if;

  -- Quien PROPONE tiene que poder: proponer algo que uno mismo no puede hacer
  -- es fabricarle a otro una tarjeta que no pidió.
  if not app.capabilities_ok(p_household, coalesce(p_requires, '[]'::jsonb)) then
    raise exception 'no autorizado';
  end if;

  if p_dedupe is null or char_length(btrim(p_dedupe)) = 0 then
    raise exception 'una propuesta sin clave de idempotencia no se guarda: '
                    'el doble clic tiene que ser detectable antes de ejecutar';
  end if;
  if p_ttl_minutes is null or p_ttl_minutes < 1 or p_ttl_minutes > 1440 then
    raise exception 'el vencimiento va entre 1 minuto y 1 día: % no es un plazo', p_ttl_minutes;
  end if;

  v_me := app.current_member_id(p_household);
  if v_me is null then raise exception 'no autorizado'; end if;

  -- Candado sobre el hogar: dos pestañas proponiendo lo mismo a la vez chocan
  -- acá y no en el índice único, para que la segunda supersede a la primera en
  -- vez de reventar con un error de base que nadie sabe traducir.
  perform 1 from public.households where id = p_household for update;

  update public.assistant_proposals
     set status = 'SUPERSEDED', decided_by = v_me, decided_at = now()
   where household_id = p_household and dedupe_key = p_dedupe and status = 'OFFERED';

  select count(*) into v_vivas from public.assistant_proposals
   where household_id = p_household and status in ('OFFERED', 'ACCEPTED');
  if v_vivas >= app.tope_propuestas_vivas() then
    raise exception 'ya hay % propuestas abiertas en esta casa: resuelve algunas antes de crear otra',
      v_vivas;
  end if;

  insert into public.assistant_proposals
    (household_id, created_by, trace_id, accion, args, risk, effect, origen,
     requires, dedupe_key, basis, resumen, expires_at)
  values
    (p_household, v_me, p_trace, p_accion, p_args, p_risk, p_effect, p_origen,
     coalesce(p_requires, '[]'::jsonb), p_dedupe, p_basis, p_resumen,
     now() + make_interval(mins => p_ttl_minutes))
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.create_assistant_proposal is
  'Escribe la propuesta. No ejecuta NADA: eso es todo el punto. Quien propone '
  'tiene que tener las mismas capacidades que exige la tarjeta, y una tarjeta '
  'clínica tiene que nombrar al integrante afectado: sin eso, la audiencia de '
  'lo clínico la decidiría el requires() de la herramienta y nada más.';

-- ---------------------------------------------------------------------------
-- LA COMPUERTA VIVE EN TYPESCRIPT. ACÁ ESTÁ SU ÚNICO PASO ATÓMICO.
-- ---------------------------------------------------------------------------
--
-- Acá hubo, por un rato, una SEGUNDA compuerta: `take_assistant_proposal`
-- decidía por su cuenta, con su propio hash (md5 del secreto suelto) y dejando
-- la fila en ACCEPTED. `ConfirmationGrant.reclamar`, en el dominio, decidía con
-- otro hash (sha256 atado a la propuesta y al integrante) y exigía OFFERED. La
-- secuencia que la server action documentaba como definitiva —primero el RPC,
-- después `reclamar`— era IMPOSIBLE: el paso 1 mataba al paso 2 por estado y
-- por hash.
--
-- Una compuerta construida dos veces es una compuerta que no existe: la que
-- corre es la más floja, y el arreglo barato el día del apuro es aflojar una de
-- las dos mitades. Así que hay UNA, y es la de TypeScript. Las razones, en
-- orden de peso:
--
--   1. Es la única que puede fabricar la llave. `runActionTool` no recibe un
--      booleano ni una fila: recibe una `ConfirmationGrant` de constructor
--      privado. plpgsql no tiene cómo producir una, así que una compuerta que
--      viva solo acá no gobierna la ejecución — la decora.
--   2. La REVALIDACIÓN (la foto contra la escena) y la verificación del SEGUNDO
--      GESTO necesitan los motores del dominio. No caben acá sin duplicar medio
--      proyecto, y un duplicado es la tercera compuerta.
--   3. El permiso se ata a UNOS argumentos (`argsDigest`), que es lo que impide
--      que un permiso para "descontar 2,0 kg" ejecute "descontar 20 kg".
--
-- Lo que quedó acá es lo único que la base hace mejor que nosotros: el
-- COMPARE-AND-SWAP ATÓMICO. `take_assistant_proposal` ya no decide nada: es la
-- implementación de `ProposalStore.tomar` (paso 6 de la compuerta) y de nada
-- más. Toma la propuesta y quema el token en la misma transacción, porque
-- comparar el token en una llamada y quemarlo en otra es la carrera que deja
-- pasar dos.
--
-- Y el token: el secreto NACE EN EL SERVIDOR DE APLICACIÓN
-- (`generarConfirmationToken`, 32 bytes) y lo que llega acá es su hash ya
-- calculado por `hashConfirmationToken`, que ATA el secreto a la propuesta y al
-- integrante. La base no hashea nada: si tuviera su propia receta —y la tenía,
-- md5 del secreto pelado— volverían a ser dos formatos que no calzan, y el
-- token dejaría de estar atado a nada.

create table public.assistant_proposal_tokens (
  proposal_id uuid not null references public.assistant_proposals (id) on delete cascade,
  member_id   uuid not null references public.household_members (id) on delete cascade,
  -- sha256 hex de  proposal_id || \u0000 || member_id || \u0000 || secreto.
  token_hash  text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at  timestamptz not null default now(),
  -- El token caduca por su cuenta, y antes no tenía con qué: el dominio
  -- comparaba un `expiraEn` que nada respaldaba.
  expires_at  timestamptz not null,
  used_at     timestamptz,
  -- Sin check de "vence después de nacer": el plazo que manda es el de la
  -- propuesta y lo impone `register_proposal_token`. Un token emitido sobre una
  -- tarjeta ya vencida nace muerto a propósito, y esa fila tiene que poder
  -- existir para que el rechazo se pruebe.
  primary key (proposal_id, token_hash)
);

create index assistant_tokens_vivos
  on public.assistant_proposal_tokens (proposal_id, member_id) where used_at is null;

alter table public.assistant_proposal_tokens enable row level security;
-- Sin ninguna política: nadie lee esta tabla por PostgREST. Por eso `tomar` es
-- un solo paso —no hay forma de que la app se traiga el hash guardado para
-- compararlo afuera, y está bien que no la haya.
revoke all on public.assistant_proposal_tokens from anon, authenticated;

/**
 * Registrar el token de confirmación. Recibe el HASH, nunca el secreto.
 *
 * Uno solo vivo por (propuesta, integrante): recargar la tarjeta reemplaza el
 * anterior en vez de acumular confirmaciones que nadie miró. Sin esto, cada
 * refresh de la pantalla dejaba otro token válido para siempre.
 */
create or replace function public.register_proposal_token(
  p_id         uuid,
  p_token_hash text,
  p_expires_at timestamptz
) returns void language plpgsql security definer set search_path = public as $$
declare v_row public.assistant_proposals; v_me uuid;
begin
  select * into v_row from public.assistant_proposals where id = p_id;
  if not found then raise exception 'no autorizado'; end if;
  if not app.capabilities_ok(v_row.household_id, v_row.requires) then raise exception 'no autorizado'; end if;
  if v_row.status <> 'OFFERED' then
    raise exception 'esta propuesta ya está en %: no hay nada que confirmar', v_row.status;
  end if;

  v_me := app.current_member_id(v_row.household_id);
  if v_me is null then raise exception 'no autorizado'; end if;

  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'el hash del token no tiene la forma que emite hashConfirmationToken';
  end if;

  -- El token no puede durar más que la tarjeta que lo llevaba puesta.
  if p_expires_at is null or p_expires_at > v_row.expires_at then
    raise exception 'un token no vive más que su propuesta';
  end if;

  delete from public.assistant_proposal_tokens
   where proposal_id = p_id and member_id = v_me and used_at is null;

  insert into public.assistant_proposal_tokens (proposal_id, member_id, token_hash, expires_at)
  values (p_id, v_me, p_token_hash, p_expires_at);
end;
$$;

comment on function public.register_proposal_token(uuid, text, timestamptz) is
  'Guarda el hash del token que la ActionCard lleva puesto. El secreto nace en '
  'el servidor de aplicación y acá no entra nunca: la base no hashea, para que '
  'no existan dos formatos de token.';

/**
 * TOMAR la propuesta: el paso 6 de la compuerta, y nada más que el paso 6.
 *
 * NO es una compuerta. No revalida, no comprueba el segundo gesto, no fabrica
 * ningún permiso: llamarlo a mano por PostgREST con un token propio no ejecuta
 * absolutamente nada — quema la confirmación de uno mismo y deja la propuesta
 * en vuelo. Lo único que abre `runActionTool` es una `ConfirmationGrant`, y esa
 * la fabrica `ConfirmationGrant.reclamar` en TypeScript, con este RPC adentro.
 *
 * Lo que sí hace, y por eso vive en la base: compare-and-swap. Sin esto, dos
 * aceptaciones concurrentes leen OFFERED las dos, revalidan las dos y ejecutan
 * las dos. El TTL no protege: se lee, no se toma.
 *
 * Devuelve un veredicto explícito y no un booleano, y esos motivos son
 * exactamente el tipo `MotivoNoTomada` del puerto `ProposalStore`. UNKNOWN !=
 * ZERO también acá: `tomada:false` sin motivo es una pantalla que no dice nada.
 */
create or replace function public.take_assistant_proposal(
  p_id         uuid,
  p_token_hash text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_row public.assistant_proposals; v_me uuid; v_tok record;
begin
  select * into v_row from public.assistant_proposals where id = p_id for update;
  if not found then
    return jsonb_build_object('tomada', false, 'motivo', 'NO_EXISTE');
  end if;

  -- El permiso que cuenta es el del QUE ACEPTA, no el del que propuso.
  if not app.capabilities_ok(v_row.household_id, v_row.requires) then
    return jsonb_build_object('tomada', false, 'motivo', 'NO_AUTORIZADO');
  end if;

  v_me := app.current_member_id(v_row.household_id);
  if v_me is null then
    return jsonb_build_object('tomada', false, 'motivo', 'NO_AUTORIZADO');
  end if;

  if v_row.status = 'ACCEPTED' then
    return jsonb_build_object('tomada', false, 'motivo', 'EN_VUELO');
  end if;
  if v_row.status <> 'OFFERED' then
    return jsonb_build_object('tomada', false, 'motivo', 'YA_DECIDIDA', 'estado', v_row.status);
  end if;
  if v_row.expires_at <= now() then
    update public.assistant_proposals
       set status = 'EXPIRED', decided_at = now()
     where id = p_id;
    return jsonb_build_object('tomada', false, 'motivo', 'VENCIDA');
  end if;

  select * into v_tok from public.assistant_proposal_tokens
   where proposal_id = p_id and member_id = v_me
     and token_hash = coalesce(p_token_hash, '')
     and used_at is null
     and expires_at > now()
   for update;
  if not found then
    -- No se distingue "token inválido" de "token de otra persona" ni de "token
    -- vencido" a propósito: la diferencia sólo le sirve a quien prueba tokens.
    return jsonb_build_object('tomada', false, 'motivo', 'SIN_CONFIRMACION');
  end if;

  update public.assistant_proposal_tokens set used_at = now()
   where proposal_id = p_id and token_hash = v_tok.token_hash;

  update public.assistant_proposals
     set status = 'ACCEPTED', decided_by = v_me, decided_at = now()
   where id = p_id;

  return jsonb_build_object(
    'tomada', true, 'motivo', null,
    'propuesta', jsonb_build_object(
      'id', v_row.id, 'accion', v_row.accion, 'args', v_row.args,
      'risk', v_row.risk, 'effect', v_row.effect, 'origen', v_row.origen,
      'dedupe_key', v_row.dedupe_key, 'basis', v_row.basis,
      'accepted_by_member_id', v_me));
end;
$$;

comment on function public.take_assistant_proposal(uuid, text) is
  'Paso 6 de la compuerta (que vive en TypeScript): compare-and-swap del gesto '
  'humano. Toma la propuesta y quema el token en la misma transacción. No '
  'ejecuta nada ni fabrica ningún permiso.';

-- ---------------------------------------------------------------------------
-- Cerrar
-- ---------------------------------------------------------------------------

create or replace function public.settle_assistant_proposal(
  p_id            uuid,
  p_status        public.assistant_proposal_status,
  p_resultado     jsonb default null,
  p_superseded_by uuid  default null
) returns void language plpgsql security definer set search_path = public as $$
declare v_row public.assistant_proposals; v_me uuid;
begin
  select * into v_row from public.assistant_proposals where id = p_id for update;
  if not found then raise exception 'no autorizado'; end if;
  if not app.capabilities_ok(v_row.household_id, v_row.requires) then raise exception 'no autorizado'; end if;

  -- Idempotente: cerrar dos veces lo ya cerrado no es un error, es el mismo
  -- destino. Lo que NO se permite es cambiar un final por otro (lo impide el
  -- trigger, y acá se evita llegar a molestarlo).
  if v_row.status not in ('OFFERED', 'ACCEPTED') then return; end if;

  -- EXECUTED significa "la acción existente devolvió ok". Sólo se llega desde
  -- ACCEPTED, o sea desde un gesto humano tomado. Sin esta línea, una propuesta
  -- podría pasar de OFFERED a EXECUTED sin que nadie tocara nada, que es
  -- exactamente el agujero que este sprint viene a tapar.
  --
  -- Los tres finales de la acción —se hizo, no se hizo, no sabemos— salen del
  -- mismo lugar y por eso los tres piden lo mismo: que alguien haya confirmado.
  if p_status in ('EXECUTED', 'FAILED', 'EXECUTION_UNKNOWN') and v_row.status <> 'ACCEPTED' then
    raise exception '% sólo se llega desde ACCEPTED: nadie confirmó esta propuesta', p_status
      using errcode = 'insufficient_privilege';
  end if;

  v_me := coalesce(app.current_member_id(v_row.household_id), v_row.decided_by);
  if v_me is null then raise exception 'no autorizado'; end if;

  update public.assistant_proposals
     set status = p_status,
         superseded_by = coalesce(p_superseded_by, superseded_by),
         resultado = coalesce(p_resultado, resultado),
         decided_by = coalesce(decided_by, v_me),
         decided_at = coalesce(decided_at, now())
   where id = p_id;
end;
$$;

/**
 * Caducar lo vencido. FUERA del camino de lectura, a propósito.
 *
 * El diseño lo tenía corriendo "en cada lectura del inbox": un GET convertido
 * en escritura. Con tres personas abriendo /inbox a la hora de la once son
 * escrituras concurrentes sobre las mismas filas, y —lo peor para el contrato
 * ERROR != VACÍO— una falla de ESCRITURA rompe una LECTURA que sólo necesitaba
 * un filtro: la persona ve "no pude verificar tu bandeja" por algo que no tenía
 * nada que ver con leer.
 *
 * La lectura filtra por predicado (`status='OFFERED' and expires_at > now()`).
 * Esto se llama desde la aceptación, desde el cron o desde mantención, acotado
 * y saltando lo que otro esté tocando.
 */
create or replace function public.expire_assistant_proposals(p_household uuid)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not app.is_household_member(p_household) then raise exception 'no autorizado'; end if;

  with vencidas as (
    select id from public.assistant_proposals
     where household_id = p_household and status = 'OFFERED' and expires_at <= now()
     order by expires_at
     limit 200
     for update skip locked
  )
  update public.assistant_proposals p
     set status = 'EXPIRED', decided_at = now()
    from vencidas v where p.id = v.id;

  get diagnostics n = row_count;
  return n;
end;
$$;

/**
 * Retención: 30 días de historia terminal y se purga.
 *
 * Va declarada JUNTO con la tabla y no "después", porque el después no llega:
 * las SUPERSEDED, EXPIRED, REJECTED y EXECUTED se acumulan con cada
 * conversación y la consulta del inbox se degrada de a poco, sin ningún
 * síntoma hasta que ya duele.
 */
create or replace function public.purge_assistant_proposals(p_household uuid)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not app.is_household_admin(p_household) then raise exception 'no autorizado'; end if;
  delete from public.assistant_proposals
   where household_id = p_household
     and status not in ('OFFERED', 'ACCEPTED')
     and created_at <= now() - interval '30 days';
  get diagnostics n = row_count;
  return n;
end;
$$;

comment on table public.assistant_proposals is
  'Toda escritura que el asistente sugiere pasa por acá. El asistente PROPONE, '
  'una persona CONFIRMA: no hay camino de código que ejecute sin una fila de '
  'esta tabla tomada por take_assistant_proposal.';
