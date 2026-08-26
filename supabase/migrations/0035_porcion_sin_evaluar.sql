-- 0035 — El falso-seguro clínico: una porción que NADIE evaluó se veía igual
--        que una porción evaluada y limpia.
--
-- HALLAZGO (auditoría posterior al Sprint 11.5, sobre código YA en producción):
-- la regla que gobierna el Sprint 11 es una sola —UNKNOWN NUNCA SIGNIFICA
-- NORMAL— y el módulo clínico la rompía en el único camino que importa.
--
--   a) `member_serving_projections.clinical_status` (0027:453) nace NULL.
--   b) El ÚNICO escritor de esa columna era `resolve_clinical_impact_review`
--      (0027:583), que es REACTIVO: escribe cuando alguien resuelve una
--      revisión de impacto. Una comida recién confirmada no pasa por ahí, así
--      que toda porción confirmada nacía —y se quedaba— en NULL.
--   c) La pantalla (`plan/comida/[assignmentId]`) y el tablero de la semana
--      (`plan/queries.ts`) sólo reaccionaban a CLINICALLY_INVALIDATED y a
--      REVIEW_REQUIRED. NULL no pintaba nada, y "no pintar nada" es
--      exactamente lo que se ve cuando la comida está evaluada y limpia.
--
-- Resultado medido: una comida jamás evaluada se presentaba como compatible.
-- El vocabulario no tenía cómo decir "todavía nadie la miró": el enum sabía
-- decir compatible, con precaución, en revisión e invalidada, y la ausencia de
-- evaluación se guardaba como un SILENCIO (NULL), que no es un estado.
--
-- Esta migración le da a la base la palabra que le faltaba y hace que la
-- porción nazca diciéndola. La conexión del motor (que confirmar una comida
-- corra la evaluación y escriba el veredicto real) va en la capa de aplicación
-- —`confirmMeal` en web/src/app/plan/actions.ts— porque el motor clínico es
-- TypeScript puro y versionado (ADR 0012): la base no evalúa, guarda.
--
-- No modifica ninguna migración congelada.
--
-- LA TRAMPA DEL ENUM (documentada en 0008:78 y repetida en 0033): un valor
-- agregado con `alter type ... add value` NO se puede usar como literal en la
-- MISMA transacción que lo creó — Postgres responde "unsafe use of new value
-- of enum type". Por eso acá:
--   · NO hay `alter column ... set default 'NOT_ASSESSED'` (el motor tendría
--     que resolver el literal ahora mismo);
--   · NO hay backfill `update ... set clinical_status = 'NOT_ASSESSED'`
--     (mismo problema);
--   · el valor SÓLO aparece dentro del CUERPO de una función, que plpgsql
--     compila recién cuando el trigger se dispara, ya en otra transacción.
--
-- Las filas históricas se quedan en NULL a propósito. NULL y NOT_ASSESSED
-- dicen lo mismo —nadie evaluó esta porción— y el lector los trata igual: la
-- regla de lectura es por COMPLEMENTO (todo lo que no es COMPATIBLE ni
-- COMPATIBLE_WITH_CAUTION requiere atención), así que ninguna de las dos puede
-- colarse como limpia. Poner la columna NOT NULL exigiría ese backfill
-- prohibido; se prefiere una columna honesta a una migración astuta.

-- ---------------------------------------------------------------------------
-- 1. El vocabulario aprende a decir "todavía nadie la evaluó"
-- ---------------------------------------------------------------------------

alter type public.clinical_assessment_status add value if not exists 'NOT_ASSESSED';

comment on type public.clinical_assessment_status is
  'Veredicto clínico de una comida para una persona. NOT_ASSESSED no es un '
  'veredicto: es la ausencia de uno, y existe para que la ausencia se pueda '
  'GUARDAR y MOSTRAR en vez de esconderse en un NULL. UNKNOWN NUNCA SIGNIFICA '
  'NORMAL: sólo COMPATIBLE y COMPATIBLE_WITH_CAUTION significan que alguien '
  'miró y salió limpia.';

-- ---------------------------------------------------------------------------
-- 2. Toda porción nace declarando que nadie la evaluó
-- ---------------------------------------------------------------------------

/**
 * Es un TRIGGER y no un DEFAULT de columna por dos razones, y la segunda pesa
 * más que la trampa del enum:
 *
 *  1. el DEFAULT no se puede escribir en esta transacción (ver cabecera);
 *  2. un DEFAULT sólo actúa cuando el insert OMITE la columna. Un insert que
 *     manda `clinical_status = null` explícitamente lo esquiva. El trigger
 *     tapa las dos puertas y, sobre todo, tapa las puertas que todavía no
 *     existen: cualquier escritor futuro de porciones queda cubierto sin
 *     acordarse de nada (regla "todo conectado": el que se olvida no puede
 *     crear un agujero silencioso).
 *
 * Nunca PISA un estado que venga puesto: si quien inserta ya trae un veredicto,
 * ese manda.
 */
create or replace function app.serving_clinical_status_default()
returns trigger language plpgsql as $$
begin
  if new.clinical_status is null then
    new.clinical_status := 'NOT_ASSESSED';
  end if;
  return new;
end;
$$;

comment on function app.serving_clinical_status_default() is
  'Una porción confirmada no puede nacer callada: sin veredicto clínico se '
  'marca NOT_ASSESSED, que la pantalla y el tablero muestran como PENDIENTE.';

drop trigger if exists member_serving_projections_clinical_default
  on public.member_serving_projections;

create trigger member_serving_projections_clinical_default
  before insert on public.member_serving_projections
  for each row execute function app.serving_clinical_status_default();
