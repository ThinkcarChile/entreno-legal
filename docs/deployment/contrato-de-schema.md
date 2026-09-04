# El contrato de schema: tres estados, no dos

## Por qué tres

Un objeto que la aplicación necesita y producción no tiene puede serlo por
razones que no se parecen en nada. Meterlas en el mismo booleano cuesta la
protección de las dos maneras posibles:

- **Todo rojo** deja el CI rojo durante toda la ventana entre escribir una
  migración y que su dueño autorice aplicarla — que puede ser días. Un CI
  crónicamente rojo se deja de mirar, y el día que aparezca un defecto de verdad
  nadie lo va a distinguir del rojo de siempre. La protección se pierde por
  desgaste, sin que nadie cambie una línea.
- **Todo verde** es el agujero original: la aplicación pedía
  `meal_serving_record_items`, la 0036 no estaba aplicada, y las 865 pruebas
  pasaban. Se descubrió con la despensa reventando contra la base real.

Por eso son tres:

| estado | qué significa | CI | despliegue |
|---|---|---|---|
| `IN_SYNC` | producción lo tiene | pasa | libre |
| `EXPECTED_PENDING_DEPLOYMENT` | lo crea una migración escrita, sellada y **demostrada** | pasa | **BLOQUEADO** |
| `CONTRACT_DEFECT` | nadie lo crea, o quien dice crearlo no está en condiciones | **FALLA** | bloqueado |

## Las dos realidades, nunca mezcladas

```
TARGET SCHEMA CONTRACT      repo + cadena limpia + app de hoy   →  tiene que PASAR
CURRENT PRODUCTION COMPAT.  app de hoy vs producción de hoy     →  IN_SYNC o
                                                                   BLOCKED_PENDING_DEPLOYMENT
```

Nunca se combinan en un solo booleano sin contexto. Que la primera pase no dice
nada sobre la segunda, y confundirlas es lo que dejó "CI verde con producción
vieja".

## Qué hace FAIL, exactamente

Un objeto es `CONTRACT_DEFECT` —y el CI falla— cuando falta en producción y
además se cumple **cualquiera** de estas. Cada una produce su propio mensaje, así
que el rojo dice cuál falló:

1. **Nadie lo crea.** Se aplicaron todas las pendientes sobre el estado real de
   producción y el objeto no apareció.
2. **Quien lo crea revienta al aplicarse** sobre ese mismo estado.
3. **No tiene entrada en el libro** de producción.
4. **El libro la declara `APLICADA`** y producción no tiene el objeto: el libro
   miente, y eso no se tapa clasificando bonito.
5. **No está sellada** (sin checksum en el libro). Una pendiente sin sellar
   todavía se está escribiendo, y apoyar la aplicación en algo que aún cambia no
   es una brecha: es trabajo a medias.
6. **Su checksum cambió** después de sellarse. En la práctica lo ataja antes
   `cargarLibroDeProduccion`, que tumba el archivo de pruebas entero nombrando la
   migración y los dos hashes.
7. **El contrato contra la cadena completa no pasa** (§3). Si el repositorio no
   garantiza el objeto ni con todo aplicado, prometer que "ya viene" es prometer
   algo que no existe.

## Qué permite EXPECTED_PENDING_DEPLOYMENT

Las siete condiciones, **todas**:

1. producción todavía no lo tiene;
2. hay una migración pendiente en el arnés;
3. está sellada;
4. su checksum coincide con el archivo de hoy;
5. **se demostró** que esa migración lo crea;
6. ninguna pendiente falla al aplicarse sobre el estado de producción;
7. el contrato contra la cadena completa pasa.

### La quinta es la que cambió de raíz

Antes, quién creaba qué se deducía con un **regex sobre el texto** de la
migración. Eso miente en las dos direcciones: un `create table` dentro de un
comentario o de una cadena calza sin crear nada, y un objeto creado con
`execute format(...)` dentro de un `do $$` no calza aunque se cree de verdad. Un
objeto mal clasificado como "ya viene en camino" es exactamente el agujero que
este contrato existe para tapar.

Ahora se **demuestra**: se levanta una base en el estado de producción, se
aplican las pendientes una por una, y después de cada una se mira qué objeto
apareció. No es una heurística — es la migración creando el objeto, observado.

## El artefacto

`supabase/schema-contract-status.json`, versionado. No una línea amarilla en la
salida de CI, que se ignora en tres días: un archivo que hay que confirmar y que
alguien revisa.

```json
{
  "target_schema": "PASS",
  "production_schema": "BLOCKED_PENDING_DEPLOYMENT",
  "release_deployment_state": "BLOCKED",
  "release_candidate_declarado": false,
  "contract_defects": [],
  "pending_objects": [ { "objeto": "…", "provisto_por": "…", "sellada": true,
                         "checksum": "…", "creacion_demostrada": true } ]
}
```

Se regenera con:

```bash
cd web && REGENERAR_CONTRATO=1 npx vitest run src/integration/gate-schema-parity.test.ts
```

Si quedó atrás, el gate se pone rojo y dice ese comando.

## El candado del Release Candidate

`release_candidate_declarado` lo pone **una persona**, y por eso existe: el gate
no puede ponerlo ni quitarlo solo. Declararlo `true` mientras
`release_deployment_state` sea `BLOCKED` pone rojo el gate con el mensaje de qué
hacer. Un Release Candidate no se puede declarar de paso.

Comprobado por mutación: declararlo con la brecha abierta pone el test en rojo;
quitarle el sello a la migración convierte la brecha en `CONTRACT_DEFECT`.

## Cómo se cierra una brecha

```bash
node scripts/poner-al-dia.mjs --pendientes                    # el plan, sin tocar nada
node scripts/poner-al-dia.mjs --pendientes --aplicar          # aplicar
node scripts/verificar-estado-produccion.mjs --escribir       # preguntarle a la base
node scripts/estado-a-documento.mjs --escribir                # el documento
cd web && REGENERAR_CONTRATO=1 npx vitest run src/integration/gate-schema-parity.test.ts
```

Cuando el libro diga **0 pendientes y 0 desacuerdos**, el artefacto pasa solo a
`IN_SYNC` / `READY`. No hay ninguna lista escrita a mano que limpiar.
