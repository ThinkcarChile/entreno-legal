import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acotarHasta, MIGRACIONES } from "./harness";

/**
 * EL INTERRUPTOR QUE ACOTA UN ENSAYO, PROBADO.
 *
 * `ENSAYO_HASTA` y `levantarBase({ hasta })` existen para el despliegue
 * controlado: cuando se va a aplicar UNA migración —porque la siguiente
 * pertenece a otro frente y no corresponde mezclarla— el ensayo tiene que probar
 * exactamente eso. Ensayar de más es tan engañoso como ensayar de menos: diría
 * que probamos algo que no vamos a hacer.
 *
 * Se escribió el día del despliegue de la 0061 y se usó SIN NINGUNA PRUEBA. Eso
 * es lo que este archivo corrige, y el riesgo no era teórico: un interruptor que
 * afloje el comportamiento por omisión convierte al guardián en decorativo
 * justamente cuando más se lo necesita.
 *
 * Las listas de casi todos los casos son SINTÉTICAS a propósito. Probarlo contra
 * las pendientes reales haría que estos tests cambiaran de significado cada vez
 * que se aplica una migración —y se pusieran verdes por vacuidad el día que no
 * quede ninguna—, que es exactamente cómo un test deja de proteger sin que nadie
 * lo note.
 */

const CADENA = [
  "supabase/migrations/0059_a.sql",
  "supabase/migrations/0060_b.sql",
  // Fuera de orden numérico A PROPÓSITO: así va la cadena real, donde la 0036 va
  // DESPUÉS de la 0037 porque ese es el orden en que producción las recibió.
  "supabase/migrations/0062_d.sql",
  "supabase/migrations/0061_c.sql",
];

describe("acotar un ensayo a lo que de verdad se va a aplicar", () => {
  it("SIN alcance no acota nada: el comportamiento por omisión no se afloja", () => {
    // La primera pregunta, y la que más importa: agregar el interruptor no puede
    // haber cambiado lo que pasa cuando nadie lo usa. `pendientes()` devuelve la
    // lista entera sin llamar a `acotarHasta`, así que acá se afirma la
    // propiedad equivalente: acotar al último número devuelve todo.
    expect(acotarHasta(CADENA, "0062")).toEqual(CADENA);
  });

  it("con alcance deja SÓLO hasta ese número, inclusive", () => {
    expect(acotarHasta(CADENA, "0061")).toEqual([
      "supabase/migrations/0059_a.sql",
      "supabase/migrations/0060_b.sql",
      "supabase/migrations/0061_c.sql",
    ]);
    expect(acotarHasta(CADENA, "0059")).toEqual(["supabase/migrations/0059_a.sql"]);
  });

  it("RESPETA EL ORDEN DEL ARNÉS, no lo reordena", () => {
    /**
     * El orden de la cadena no es el numérico: la 0036 va DESPUÉS de la 0037
     * porque así las recibió producción. Un filtro que de paso ordenara
     * produciría una secuencia que ninguna prueba ejercita y que nadie aplicó
     * nunca — y sobre una base clínica eso no se descubre hasta que falla.
     */
    const desordenada = [
      "supabase/migrations/0037_b.sql",
      "supabase/migrations/0036_a.sql",
      "supabase/migrations/0038_c.sql",
    ];
    expect(acotarHasta(desordenada, "0038")).toEqual(desordenada);
    expect(acotarHasta(desordenada, "0037")).toEqual([
      "supabase/migrations/0037_b.sql",
      "supabase/migrations/0036_a.sql",
    ]);
  });

  it("un número que no está en la lista NO inventa nada: devuelve vacío", () => {
    // Devolver vacío es la respuesta correcta de una FUNCIÓN. Quien la llama
    // decide si eso es un error — y en el ensayo lo es, como afirma el test de
    // más abajo. Separar las dos cosas evita que la función mienta para tapar un
    // error de quien la usa.
    expect(acotarHasta(CADENA, "0001")).toEqual([]);
    expect(acotarHasta(CADENA, "0058")).toEqual([]);
  });

  it("un alcance MAYOR que todo lo que hay devuelve todo, no falla", () => {
    expect(acotarHasta(CADENA, "9999")).toEqual(CADENA);
  });

  it("una entrada repetida NO se aplica dos veces", () => {
    // El filtro conserva lo que le den, así que un duplicado en la entrada sale
    // duplicado. La garantía de "no se aplica dos veces" la tiene que dar la
    // lista de origen, y por eso se afirma sobre la de verdad.
    const conRepetida = [...CADENA, "supabase/migrations/0061_c.sql"];
    expect(acotarHasta(conRepetida, "0061").length).toBe(4);
    expect(new Set(MIGRACIONES).size, "el arnés trae una migración repetida").toBe(
      MIGRACIONES.length,
    );
  });

  it("comparar los números como TEXTO es correcto: ninguno viene sin relleno", () => {
    /**
     * `acotarHasta` compara los cuatro dígitos como cadena, y eso sólo funciona
     * mientras todos vengan rellenos con ceros ("0060" < "0061" < "0100"). Si
     * alguien agregara una `61_x.sql` sin relleno, la comparación de texto la
     * pondría ANTES de "0059" y el acotado dejaría fuera migraciones que sí
     * corresponden — en silencio.
     *
     * Se mira el DISCO y no `MIGRACIONES`, porque un archivo mal nombrado puede
     * existir antes de engancharse al arnés, y es ahí donde conviene atraparlo.
     */
    const enDisco = readdirSync(path.resolve(__dirname, "../../../supabase/migrations")).filter(
      (f) => f.endsWith(".sql"),
    );
    expect(enDisco.length, "no se leyó ninguna migración: el barrido está roto").toBeGreaterThan(50);
    const malNombradas = enDisco.filter((f) => !/^\d{4}_/.test(f));
    expect(malNombradas, "migraciones sin número de cuatro dígitos al principio").toEqual([]);
  });

  it("el arnés y el ensayo usan LA MISMA regla, no dos copias", () => {
    // Nació duplicada: una copia en `levantarBase` para cortar la cadena y otra
    // en el ensayo para cortar las pendientes. Dos copias de la misma regla
    // terminan discrepando, y la que discrepe hará que un ensayo diga que probó
    // algo que no probó. Acá se afirma que la función existe y es una sola;
    // que ambos la usen lo garantiza el typecheck.
    expect(typeof acotarHasta).toBe("function");
    expect(acotarHasta(MIGRACIONES, "0060").every((m) => MIGRACIONES.includes(m))).toBe(true);
  });
});
