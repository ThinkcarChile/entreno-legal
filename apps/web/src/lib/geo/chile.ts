/**
 * Regiones y comunas de Chile.
 *
 * Se modelan como datos de referencia (no como enum ni texto libre) para poder
 * filtrar, construir páginas SEO regionales y agregar países sin migraciones
 * destructivas. `code` es un identificador estable y apto para URL; la columna
 * `official_code` en la base queda reservada para el código INE/SUBDERE.
 */

export interface Region {
  code: string;
  /** Numeral romano tradicional. "RM" para la Metropolitana. */
  ordinal: string;
  name: string;
  shortName: string;
  countryCode: string;
  timezone: string;
  communes: readonly Commune[];
}

export interface Commune {
  code: string;
  name: string;
  regionCode: string;
  /** Solo cuando difiere de la zona horaria de la región (Isla de Pascua). */
  timezone?: string;
}

/**
 * Este módulo no importa nada del resto de la aplicación a propósito: así puede
 * ejecutarse desde un script de Node para generar la semilla SQL, y la interfaz
 * y la base de datos comparten exactamente la misma lista de comunas.
 */
function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function build(
  code: string,
  ordinal: string,
  name: string,
  shortName: string,
  communeNames: readonly (string | [string, string])[],
  timezone = "America/Santiago",
): Region {
  return {
    code,
    ordinal,
    name,
    shortName,
    countryCode: "CL",
    timezone,
    communes: communeNames.map((entry) => {
      const [communeName, tz] = Array.isArray(entry) ? entry : [entry, undefined];
      return {
        code: `${code}-${slugify(communeName)}`,
        name: communeName,
        regionCode: code,
        ...(tz ? { timezone: tz } : {}),
      };
    }),
  };
}

export const regions: readonly Region[] = [
  build("15", "XV", "Arica y Parinacota", "Arica y Parinacota", [
    "Arica", "Camarones", "General Lagos", "Putre",
  ]),
  build("01", "I", "Tarapacá", "Tarapacá", [
    "Alto Hospicio", "Camiña", "Colchane", "Huara", "Iquique", "Pica", "Pozo Almonte",
  ]),
  build("02", "II", "Antofagasta", "Antofagasta", [
    "Antofagasta", "Calama", "María Elena", "Mejillones", "Ollagüe",
    "San Pedro de Atacama", "Sierra Gorda", "Taltal", "Tocopilla",
  ]),
  build("03", "III", "Atacama", "Atacama", [
    "Alto del Carmen", "Caldera", "Chañaral", "Copiapó", "Diego de Almagro",
    "Freirina", "Huasco", "Tierra Amarilla", "Vallenar",
  ]),
  build("04", "IV", "Coquimbo", "Coquimbo", [
    "Andacollo", "Canela", "Combarbalá", "Coquimbo", "Illapel", "La Higuera",
    "La Serena", "Los Vilos", "Monte Patria", "Ovalle", "Paihuano", "Punitaqui",
    "Río Hurtado", "Salamanca", "Vicuña",
  ]),
  build("05", "V", "Valparaíso", "Valparaíso", [
    "Algarrobo", "Cabildo", "Calera", "Calle Larga", "Cartagena", "Casablanca",
    "Catemu", "Concón", "El Quisco", "El Tabo", "Hijuelas", ["Isla de Pascua", "Pacific/Easter"],
    ["Juan Fernández", "America/Santiago"], "La Cruz", "La Ligua", "Limache", "Llaillay",
    "Los Andes", "Nogales", "Olmué", "Panquehue", "Papudo", "Petorca", "Puchuncaví",
    "Putaendo", "Quillota", "Quilpué", "Quintero", "Rinconada", "San Antonio",
    "San Esteban", "San Felipe", "Santa María", "Santo Domingo", "Valparaíso",
    "Villa Alemana", "Viña del Mar", "Zapallar",
  ]),
  build("13", "RM", "Región Metropolitana de Santiago", "Metropolitana", [
    "Alhué", "Buin", "Calera de Tango", "Cerrillos", "Cerro Navia", "Colina",
    "Conchalí", "Curacaví", "El Bosque", "El Monte", "Estación Central", "Huechuraba",
    "Independencia", "Isla de Maipo", "La Cisterna", "La Florida", "La Granja",
    "La Pintana", "La Reina", "Lampa", "Las Condes", "Lo Barnechea", "Lo Espejo",
    "Lo Prado", "Macul", "Maipú", "María Pinto", "Melipilla", "Ñuñoa",
    "Padre Hurtado", "Paine", "Pedro Aguirre Cerda", "Peñaflor", "Peñalolén",
    "Pirque", "Providencia", "Pudahuel", "Puente Alto", "Quilicura", "Quinta Normal",
    "Recoleta", "Renca", "San Bernardo", "San Joaquín", "San José de Maipo",
    "San Miguel", "San Pedro", "San Ramón", "Santiago", "Talagante", "Tiltil", "Vitacura",
  ]),
  build("06", "VI", "Libertador General Bernardo O'Higgins", "O'Higgins", [
    "Chépica", "Chimbarongo", "Codegua", "Coinco", "Coltauco", "Doñihue", "Graneros",
    "La Estrella", "Las Cabras", "Litueche", "Lolol", "Machalí", "Malloa", "Marchihue",
    "Mostazal", "Nancagua", "Navidad", "Olivar", "Palmilla", "Paredones", "Peralillo",
    "Peumo", "Pichidegua", "Pichilemu", "Placilla", "Pumanque", "Quinta de Tilcoco",
    "Rancagua", "Rengo", "Requínoa", "San Fernando", "San Vicente", "Santa Cruz",
  ]),
  build("07", "VII", "Maule", "Maule", [
    "Cauquenes", "Chanco", "Colbún", "Constitución", "Curepto", "Curicó", "Empedrado",
    "Hualañé", "Licantén", "Linares", "Longaví", "Maule", "Molina", "Parral", "Pelarco",
    "Pelluhue", "Pencahue", "Rauco", "Retiro", "Río Claro", "Romeral", "Sagrada Familia",
    "San Clemente", "San Javier", "San Rafael", "Talca", "Teno", "Vichuquén",
    "Villa Alegre", "Yerbas Buenas",
  ]),
  build("16", "XVI", "Ñuble", "Ñuble", [
    "Bulnes", "Chillán", "Chillán Viejo", "Cobquecura", "Coelemu", "Coihueco",
    "El Carmen", "Ninhue", "Ñiquén", "Pemuco", "Pinto", "Portezuelo", "Quillón",
    "Quirihue", "Ránquil", "San Carlos", "San Fabián", "San Ignacio", "San Nicolás",
    "Treguaco", "Yungay",
  ]),
  build("08", "VIII", "Biobío", "Biobío", [
    "Alto Biobío", "Antuco", "Arauco", "Cabrero", "Cañete", "Chiguayante",
    "Concepción", "Contulmo", "Coronel", "Curanilahue", "Florida", "Hualpén",
    "Hualqui", "Laja", "Lebu", "Los Álamos", "Los Ángeles", "Lota", "Mulchén",
    "Nacimiento", "Negrete", "Penco", "Quilaco", "Quilleco", "San Pedro de la Paz",
    "San Rosendo", "Santa Bárbara", "Santa Juana", "Talcahuano", "Tirúa", "Tomé",
    "Tucapel", "Yumbel",
  ]),
  build("09", "IX", "La Araucanía", "Araucanía", [
    "Angol", "Carahue", "Cholchol", "Collipulli", "Cunco", "Curacautín", "Curarrehue",
    "Ercilla", "Freire", "Galvarino", "Gorbea", "Lautaro", "Loncoche", "Lonquimay",
    "Los Sauces", "Lumaco", "Melipeuco", "Nueva Imperial", "Padre Las Casas",
    "Perquenco", "Pitrufquén", "Pucón", "Purén", "Renaico", "Saavedra", "Temuco",
    "Teodoro Schmidt", "Toltén", "Traiguén", "Victoria", "Vilcún", "Villarrica",
  ]),
  build("14", "XIV", "Los Ríos", "Los Ríos", [
    "Corral", "Futrono", "La Unión", "Lago Ranco", "Lanco", "Los Lagos", "Máfil",
    "Mariquina", "Paillaco", "Panguipulli", "Río Bueno", "Valdivia",
  ]),
  build("10", "X", "Los Lagos", "Los Lagos", [
    "Ancud", "Calbuco", "Castro", "Chaitén", "Chonchi", "Cochamó", "Curaco de Vélez",
    "Dalcahue", "Fresia", "Frutillar", "Futaleufú", "Hualaihué", "Llanquihue",
    "Los Muermos", "Maullín", "Osorno", "Palena", "Puerto Montt", "Puerto Octay",
    "Puerto Varas", "Puqueldón", "Purranque", "Puyehue", "Queilén", "Quellón",
    "Quemchi", "Quinchao", "Río Negro", "San Juan de la Costa", "San Pablo",
  ]),
  build("11", "XI", "Aysén del General Carlos Ibáñez del Campo", "Aysén", [
    "Aysén", "Chile Chico", "Cisnes", "Cochrane", "Coyhaique", "Guaitecas",
    "Lago Verde", "O'Higgins", "Río Ibáñez", "Tortel",
  ]),
  build(
    "12",
    "XII",
    "Magallanes y de la Antártica Chilena",
    "Magallanes",
    [
      "Antártica", "Cabo de Hornos", "Laguna Blanca", "Natales", "Porvenir",
      "Primavera", "Punta Arenas", "Río Verde", "San Gregorio", "Timaukel",
      "Torres del Paine",
    ],
    "America/Punta_Arenas",
  ),
] as const;

const regionByCode = new Map(regions.map((r) => [r.code, r]));
const communeByCode = new Map(
  regions.flatMap((r) => r.communes.map((c) => [c.code, c] as const)),
);

export function getRegion(code: string): Region | undefined {
  return regionByCode.get(code);
}

export function getCommune(code: string): Commune | undefined {
  return communeByCode.get(code);
}

export function getCommunes(regionCode: string): readonly Commune[] {
  return regionByCode.get(regionCode)?.communes ?? [];
}

export function allCommunes(): readonly Commune[] {
  return [...communeByCode.values()];
}

/** Zona horaria efectiva: la de la comuna si la sobreescribe, si no la de la región. */
export function timezoneFor(regionCode: string, communeCode?: string | null): string {
  if (communeCode) {
    const commune = communeByCode.get(communeCode);
    if (commune?.timezone) return commune.timezone;
  }
  return regionByCode.get(regionCode)?.timezone ?? "America/Santiago";
}

export function regionName(code: string): string {
  return regionByCode.get(code)?.shortName ?? code;
}

export function communeName(code: string): string {
  return communeByCode.get(code)?.name ?? code;
}

/** Regiones ordenadas de norte a sur, como se enseñan en Chile. */
export const regionsNorthToSouth = regions;
