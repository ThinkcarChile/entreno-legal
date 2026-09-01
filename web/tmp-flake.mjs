import { PGlite } from "@electric-sql/pglite";

const SQL = (testigo) => `
create or replace function pg_temp.testigo_presente(p_expresion text)
returns boolean language plpgsql as $fn$
declare v_resultado boolean;
begin
  execute 'select (' || p_expresion || ')' into v_resultado;
  return v_resultado;
exception
  when undefined_table or undefined_function or undefined_column
    or undefined_object or invalid_schema_name then
    return false;
end $fn$;

select t.archivo, pg_temp.testigo_presente(t.expresion) as presente
from (values
    ('x.sql', ${testigo})
) as t(archivo, expresion)
order by t.archivo;
`;

const CASOS = ["'(1/0) = 1'", "'''no soy un numero''::int = 1'"];

let resueltos = 0;
for (let vuelta = 0; vuelta < 40; vuelta += 1) {
  // Igual que el test: NO se espera a que PGlite esté lista.
  const db = new PGlite();
  for (const caso of CASOS) {
    try {
      const r = await db.exec(SQL(caso));
      resueltos += 1;
      console.log(`vuelta ${vuelta} caso ${caso}: RESOLVIÓ`, JSON.stringify(r[r.length - 1]?.rows));
    } catch (e) {
      if (vuelta === 0) console.log(`vuelta 0 caso ${caso}: rechazó con code=${e.code ?? "?"}`);
    }
  }
  await db.close();
}
console.log("resoluciones indebidas:", resueltos, "de", 40 * CASOS.length);
