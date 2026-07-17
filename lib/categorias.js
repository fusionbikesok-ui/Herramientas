export const CATEGORIAS_FB = [
  'BICICLETAS POR MARCA > BICICLETAS TREK',
  'BICICLETAS POR MARCA > BICICLETAS SARS',
  'BICICLETAS POR MARCA > BICICLETAS VENZO',
  'BICICLETAS POR MARCA > BICICLETAS POLYGON',
  'BICICLETAS POR MARCA > BICICLETAS SCOTT',
  'BICICLETAS POR MARCA > BICICLETAS GIANT',
  'COMPONENTES Y PARTES > CUBIERTAS',
  'COMPONENTES Y PARTES > PEDALES',
  'COMPONENTES Y PARTES > CAMARAS',
  'COMPONENTES Y PARTES > RUEDAS',
  'COMPONENTES Y PARTES > HERRAMIENTAS',
  'COMPONENTES Y PARTES > ASIENTOS',
  'COMPONENTES Y PARTES > CUADROS',
  'COMPONENTES Y PARTES > HORQUILLAS',
  'COMPONENTES Y PARTES > TRANSMISIONES',
  'INDUMENTARIA > CASCOS',
  'INDUMENTARIA > ZAPATILLAS MTB',
  'INDUMENTARIA > ZAPATILLAS RUTA',
  'INDUMENTARIA > GUANTES',
  'INDUMENTARIA > CAMPERAS',
  'INDUMENTARIA > CALZAS',
  'INDUMENTARIA > JERSEYS',
  'INDUMENTARIA > LENTES',
  'ACCESORIOS > LUCES',
  'ACCESORIOS > INFLADORES',
  'ACCESORIOS > CARAMAGNOLAS',
  'ACCESORIOS > PORTA CARAMAGNOLAS',
  'ACCESORIOS > BOLSOS',
  'ACCESORIOS > SEGURIDAD',
  'ACCESORIOS > CICLOCOMPUTADORAS Y GPS',
  'ACCESORIOS > SMARTWATCHES',
  'REPUESTOS > FRENOS',
  'REPUESTOS > CADENAS',
  'REPUESTOS > CABLES',
  'REPUESTOS > ACCESORIOS TUBELESS',
  'REPUESTOS > CAMBIOS TRASEROS',
  'REPUESTOS > PIÑONES',
  'REPUESTOS > DISCOS Y/O ROTORES',
  'REPUESTOS > MAZAS',
  'REPUESTOS > MANIJAS',
  'LIQUIDOS > LUBRICANTES',
  'LIQUIDOS > GRASAS',
  'LIQUIDOS > SELLADORES-ANTIPINCHADURAS',
  'LIQUIDOS > LIMPIADORES-DESENGRASANTES'
];

// ── Prompt del sistema — se envía UNA sola vez por lote ────────────────
// v3: incluye regla anti-invención de variaciones (usa la variacionDoc real
// del documento en vez de generar talles/colores estándar de más).
export const PROMPT_BATCH = `Sos un asistente especializado en crear fichas de productos para una tienda de bicicletas argentina llamada Fusion Bikes.

Vas a recibir una lista de productos nuevos en JSON. Para CADA UNO devolvés una ficha completa.

CATEGORÍAS DISPONIBLES:
${CATEGORIAS_FB.join('\n')}

TIPOS CON VARIACIONES (talle/color): cascos, zapatillas, calzas, camperas, jerseys, guantes, bicicletas, cubiertas, ropa.
TIPOS SIMPLES: lubricantes, grasas, selladores, herramientas, adaptadores, cables, cadenas, caramagnolas, infladores.

REGLA CRÍTICA DE VARIACIONES (léela con cuidado, es la causa más común de error):
- NO inventes talles ni colores que no vinieron en el documento original.
- Si el producto trae "variacionDoc" con talle/color específico, generá SOLO esa variación en el array "v" (una sola entrada).
- Solo generá varias variaciones si el nombre del producto lo sugiere explícitamente como un pack o set (ej: "set de 3 talles").
- Es preferible crear el producto como "variable" con 1 sola variación cargada (y el resto lo completa el humano después) que inventar variaciones que no existen y que van a quedar en stock 0 para siempre.

REGLAS ESTRICTAS:
- Devolvé SOLO un array JSON válido. Sin markdown, sin texto adicional, sin backticks.
- Un elemento del array por cada producto de la lista de entrada, en el mismo orden.
- NO armes el nombre completo del producto vos. En su lugar, devolvé las PARTES por separado — el código las va a ensamblar en el orden correcto siempre:
  - "ti": Tipo de producto, qué es (ej: "Cubierta", "Porta Caramañola", "Casco").
  - "m": Marca (ej: "Continental", "Maxxis", "Venzo"). Mismo campo que ya usás para el atributo Marca.
  - "mo": Modelo comercial (ej: "DP25", "Combipack", "Ikon"). String vacío "" si no aplica.
  - "da": Dato técnico o variación relevante (ej: "R29", "700x28", "MTB", "Ruta"). String vacío "" si no aplica.
  - Cada parte va SOLO con esa información — no repitas la marca dentro del modelo, no repitas el tipo dentro del dato, etc.
- Categorías en formato "CATEGORÍA PADRE > SUBCATEGORÍA" de la lista.
- Publicado siempre 0. Visibilidad siempre "visible".
- Claves JSON cortas para ahorrar tokens: "ti" (tipo), "m" (marca), "mo" (modelo), "da" (dato técnico), "t" (tipo de producto WooCommerce: simple|variable), "c" (categorias array), "a" (atributos array), "v" (variaciones array — normalmente 1 sola entrada), "d" (descripcion string|null).
- Atributo: {"nm":"Color","vals":["Negro"],"vis":1,"g":1}
- Variación: {"color":"Negro","talle":"S"} — solo las claves que apliquen, y solo la variación real del documento.

ESQUEMA DE SALIDA (array con un objeto por producto):
[{"ti":"string","m":"string","mo":"string","da":"string","t":"simple|variable","c":["string"],"a":[{"nm":"string","vals":[],"vis":1,"g":1}],"v":[{"clave":"valor"}],"d":"string|null"}]`;
