/*
 * src/catalogo/arbol-fusionbikes.ts — E2 T3 tarea 5: el árbol propio de FusionBikes, definido por José
 * (D1–D7 del plan, docs/superpowers/plans/2026-09-20-e2-tramo3-taxonomia-colecciones-packs.md).
 *
 * DOS NIVELES y no más, por decisión de diseño (D7): el menú de la home despliega el nivel 1 y muestra el
 * nivel 2, y todo lo que en la jerarquía de Woo era un tercer nivel pasa a ser FACETA sobre atributos del
 * modelo. Por eso `PASTILLAS DE FRENO` o `CUBIERTAS` no están acá: no son «qué clase de cosa es» sino «cuál»,
 * y como nodos habría que mantener el mismo dato en el árbol y en el atributo, que es como se desincronizan.
 *
 * Las marcas NO desaparecen del eje de marcas por aparecer acá como nodo (`FANTTIK`, `SANTINI`, las de bici):
 * si sólo fueran nodos, filtrar por marca dejaría de funcionar. Están en los dos lugares a propósito, con
 * roles distintos: el nodo es un lugar en el menú, la marca es un eje de filtrado.
 */

/** Un nodo del árbol propio. `clave` es estable e independiente del nombre: renombrar no rompe el mapeo. */
export interface NodoFusion {
  clave: string;
  nombre: string;
  padre: string | null;
  rubro?: 'producto' | 'servicio';
}

// Las claves son PLANAS y no rutas. `taxonomy_nodes_clave_check` es `^[a-z0-9][a-z0-9_-]*$` y no admite `/`:
// con claves por ruta, 59 de los 65 nodos no se podían escribir. Lo encontró opt-2b revisando, y la ruta la
// había justificado con un choque de nombres (dos `INFLADORES`) que ya no existe, porque esa categoría quedó
// absorbida. Si algún día vuelve un nombre repetido, la clave del segundo lo desambigua a mano, no el padre.

const hijos = (padre: string, nombres: Array<[string, string]>): NodoFusion[] =>
  nombres.map(([clave, nombre]) => ({ clave, nombre, padre }));

export const ARBOL_FUSIONBIKES: NodoFusion[] = [
  { clave: 'bicicletas', nombre: 'BICICLETAS POR MARCA', padre: null },
  ...hijos('bicicletas', [
    ['trek', 'BICICLETAS TREK'], ['venzo', 'BICICLETAS VENZO'], ['volta', 'BICICLETAS VOLTA'],
    ['polygon', 'BICICLETAS POLYGON'], ['zion', 'BICICLETAS ZION'], ['twitter', 'BICICLETAS TWITTER'],
    ['topmega', 'BICICLETAS TOPMEGA'], ['sava', 'BICICLETAS SAVA'], ['sars', 'BICICLETAS SARS'],
    ['gravity', 'BICICLETAS GRAVITY'], ['haven', 'BICICLETAS HAVEN'],
    ['mafia-bikes', 'BICICLETAS MAFIA BIKES'], ['rembrandt', 'BICICLETAS REMBRANDT'],
    ['schwinn', 'BICICLETAS SCHWINN'], ['infantiles', 'BICICLETAS INFANTILES'],
  ]),

  { clave: 'componentes', nombre: 'COMPONENTES Y REPUESTOS', padre: null },
  ...hijos('componentes', [
    ['transmision', 'TRANSMISIÓN'], ['frenos', 'FRENOS'], ['ruedas', 'RUEDAS'],
    ['cubiertas-y-camaras', 'Cubiertas y Cámaras'], ['direccion', 'Dirección'],
    ['asientos', 'ASIENTOS'], ['horquillas', 'HORQUILLAS'],
    ['pedales-y-trabas', 'PEDALES Y TRABAS'], ['cuadros', 'CUADROS'],
  ]),

  { clave: 'accesorios', nombre: 'ACCESORIOS', padre: null },
  ...hijos('accesorios', [
    ['ciclocomputadoras-y-gps', 'CICLOCOMPUTADORAS Y GPS'],
    ['infladores-y-herramientas', 'INFLADORES Y HERRAMIENTAS'],
    ['hidratacion', 'HIDRATACIÓN'], ['luces-y-seguridad', 'LUCES Y SEGURIDAD'],
    ['soportes-y-estacionamiento', 'SOPORTES Y ESTACIONAMIENTO'], ['bolsos', 'BOLSOS'],
    ['rodillos', 'RODILLOS DE ENTRENAMIENTO'], ['portabicicletas', 'PORTABICICLETAS'],
    ['cintas-y-punos', 'CINTAS Y PUÑOS'], ['cubre-vaina', 'CUBRE VAINA'], ['cuernitos', 'CUERNITOS'],
    ['camaras-deportivas', 'CÁMARAS DEPORTIVAS'], ['sillas-traseras', 'SILLAS TRASERAS'],
    ['porta-celular', 'PORTA CELULAR'], ['porta-objetos', 'PORTA OBJETOS'], ['fanttik', 'FANTTIK'],
  ]),

  { clave: 'indumentaria', nombre: 'INDUMENTARIA Y CALZADO', padre: null },
  ...hijos('indumentaria', [
    ['zapatillas', 'ZAPATILLAS'], ['cascos', 'CASCOS'], ['lentes', 'LENTES'],
    ['jerseys-y-calzas', 'JERSEYS Y CALZAS'], ['camperas', 'CAMPERAS Y ROMPEVIENTOS'],
    ['guantes', 'GUANTES'], ['medias', 'MEDIAS'], ['remeras', 'REMERAS'], ['buzos', 'BUZOS'],
    ['gorros', 'GORROS'], ['piernas', 'PIERNAS'], ['mangas', 'MANGAS'],
    ['cuellos-multiuso', 'CUELLOS MULTIUSO'],
  ]),

  // `TALLER` absorbió la raíz `LÍQUIDOS`, que deja de existir: sus cinco hijas cuelgan acá.
  { clave: 'taller', nombre: 'TALLER', padre: null },
  ...hijos('taller', [
    ['lubricantes', 'LUBRICANTES'], ['grasas', 'GRASAS'],
    ['selladores', 'SELLADORES/ANTIPINCHADURAS'], ['limpiadores', 'LIMPIADORES/DESENGRASANTES'],
    ['liquidos-de-frenos', 'LIQUIDOS DE FRENOS'],
  ]),
  { clave: 'services', nombre: 'SERVICES', padre: 'taller', rubro: 'servicio' },

  { clave: 'santini', nombre: 'SANTINI', padre: null },
];

/**
 * El destino de CADA categoría de Woo, explícito y por id. Antes 61 de las 78 se resolvían haciendo coincidir
 * el nombre del nodo con el de la categoría, y eso es exactamente donde un cambio de tipeo en Woo rompe un
 * mapeo sin que nada proteste: la categoría deja de encontrar su nodo y sus modelos se quedan sin clasificar,
 * en silencio. Acá el nombre es sólo un comentario; lo que manda es el id, que Woo no cambia.
 *
 * Varias categorías pueden apuntar al MISMO nodo: es la absorción de D7, el árbol tiene dos niveles y el
 * tercero de Woo se vuelve faceta. Requiere la migración 0016 (antes había un único por nodo).
 */
export const MAPEO_WOO: Record<string, string> = {
  '26': 'horquillas',                  // HORQUILLAS
  '27': 'zapatillas',                  // ZAPATILLAS
  '30': 'asientos',                    // ASIENTOS
  '57': 'accesorios',                  // ACCESORIOS
  '59': 'taller',                      // LÍQUIDOS
  '60': 'componentes',                 // COMPONENTES Y REPUESTOS
  '61': 'indumentaria',                // INDUMENTARIA Y CALZADO
  '62': 'bicicletas',                  // BICICLETAS POR MARCA
  '65': 'soportes-y-estacionamiento',  // SOPORTES Y ESTACIONAMIENTO
  '66': 'portabicicletas',             // PORTABICICLETAS
  '67': 'rodillos',                    // RODILLOS DE ENTRENAMIENTO
  '68': 'luces-y-seguridad',           // LUCES Y SEGURIDAD
  '69': 'ciclocomputadoras-y-gps',     // CICLOCOMPUTADORAS Y GPS
  '70': 'infladores-y-herramientas',   // INFLADORES Y HERRAMIENTAS
  '71': 'hidratacion',                 // HIDRATACIÓN
  '74': 'bolsos',                      // BOLSOS
  '75': 'cintas-y-punos',              // CINTAS Y PUÑOS
  '79': 'asientos',                    // FUNDAS ASIENTO
  '82': 'porta-objetos',               // PORTA OBJETOS
  '95': 'frenos',                      // FRENOS
  '96': 'cubiertas-y-camaras',         // ACCESORIOS TUBELESS
  '105': 'ruedas',                      // EJES PASANTES
  '107': 'ruedas',                      // MAZAS
  '108': 'transmision',                 // FUSIBLES
  '114': 'lubricantes',                 // LUBRICANTES
  '115': 'grasas',                      // GRASAS
  '116': 'selladores',                  // SELLADORES/ANTIPINCHADURAS
  '117': 'limpiadores',                 // LIMPIADORES/DESENGRASANTES
  '119': 'cubiertas-y-camaras',         // CUBIERTAS
  '120': 'pedales-y-trabas',            // PEDALES Y TRABAS
  '121': 'cuadros',                     // CUADROS
  '122': 'infladores-y-herramientas',   // HERRAMIENTAS
  '126': 'cubiertas-y-camaras',         // CAMARAS
  '127': 'ruedas',                      // RUEDAS
  '129': 'asientos',                    // PORTASILLAS
  '130': 'direccion',                   // MANUBRIOS
  '131': 'direccion',                   // STEMS/AVANCES
  '132': 'pedales-y-trabas',            // CALAS / TRABAS
  '134': 'asientos',                    // COLLARES DE ASIENTO
  '135': 'transmision',                 // SHIFTERS
  '138': 'venzo',                       // BICICLETAS VENZO
  '140': 'topmega',                     // BICICLETAS TOPMEGA
  '142': 'volta',                       // BICICLETAS VOLTA
  '144': 'sava',                        // BICICLETAS SAVA
  '145': 'zion',                        // BICICLETAS ZION
  '185': 'guantes',                     // GUANTES
  '189': 'lentes',                      // LENTES
  '190': 'camperas',                    // CAMPERAS Y ROMPEVIENTOS
  '191': 'jerseys-y-calzas',            // CALZAS
  '192': 'jerseys-y-calzas',            // JERSEYS Y CALZAS
  '193': 'camperas',                    // CHALECOS
  '196': 'piernas',                     // PIERNAS
  '197': 'remeras',                     // REMERAS
  '199': 'mangas',                      // MANGAS
  '200': 'cuellos-multiuso',            // CUELLOS MULTIUSO
  '202': 'medias',                      // MEDIAS
  '205': 'cascos',                      // CASCOS
  '343': 'services',                    // SERVICES
  '715': 'liquidos-de-frenos',          // LIQUIDOS DE FRENOS
  '788': 'ciclocomputadoras-y-gps',     // POTENCIOMETROS
  '839': 'horquillas',                  // REPUESTOS PARA HORQUILLAS
  '840': 'mafia-bikes',                 // BICICLETAS MAFIA BIKES
  '997': 'twitter',                     // BICICLETAS TWITTER
  '1012': 'polygon',                     // BICICLETAS POLYGON
  '1036': 'gravity',                     // BICICLETAS GRAVITY
  '1112': 'trek',                        // BICICLETAS TREK
  '1144': 'camaras-deportivas',          // CÁMARAS DEPORTIVAS
  '1152': 'haven',                       // BICICLETAS HAVEN
  '1205': 'fanttik',                     // FANTTIK
  '1208': 'fanttik',                     // ASPIRADORAS
  '1209': 'infladores-y-herramientas',   // INFLADORES
  '1224': 'sars',                        // BICICLETAS SARS
  '1230': 'gorros',                      // GORROS
  '1472': 'transmision',                 // TRANSMISIÓN
  '1477': 'cubiertas-y-camaras',         // Cubiertas y Cámaras
  '1518': 'taller',                      // Taller
  '1524': 'schwinn',                     // BICICLETAS SCHWINN
  '1538': 'infantiles',                  // BICICLETAS INFANTILES
};

/** Categorías de Woo que quedan FUERA del árbol por decisión: sus modelos van a clasificar a mano. */
export const FUERA_DEL_ARBOL: Record<string, string> = {
  '746': 'Hotsale es una colección con vigencia, no un nodo (D2)',
  '1459': 'OTROS sale del árbol; su producto se clasifica a mano',
  '260': 'QR PAGOS sale del árbol; su producto se clasifica a mano',
  '389': 'SMARTWATCH sale del árbol; su producto se clasifica a mano',
};

/**
 * Categorías de MercadoLibre → nodo del árbol propio, por id (el nombre va de comentario). Sólo las diez que
 * cubren la mitad del catálogo; el resto lo decide José aparte.
 *
 * DECISIÓN CONSCIENTE: ML es MÁS fino que el árbol. `Piñones → transmision` colapsa a propósito la
 * granularidad de ML (D7: lo fino es atributo, no nodo), y es lo que va a bajar las «contradicciones reales» del
 * informe. CUANDO LOS DOS CANALES ESTÉN MAPEADOS, EL PUENTE DE GRANULARIDAD DE `medirCobertura` SE RETIRA: la
 * pregunta pasa a ser «¿caen en el mismo nodo?», exacta. No se sigue afinando el puente.
 *
 * D8: `MLA6143` (460 modelos) va al nodo RAÍZ `bicicletas`. ML las mete en una sola categoría y el árbol las
 * separa en 15 marcas; un mapeo apunta a un nodo y la marca la resuelve el atributo de marca. No se inventa
 * un nodo genérico ni se reparte por marca.
 */
export const MAPEO_ML: Record<string, string> = {
  MLA6143: 'bicicletas',                // Bicicletas Convencionales (460 modelos)
  MLA371625: 'cubiertas-y-camaras',     // Cubiertas de Bicicleta
  MLA9766: 'cascos',                    // Cascos
  MLA429231: 'zapatillas',              // Zapatillas de Ciclismo
  MLA429032: 'lubricantes',             // Lubricantes
  MLA429725: 'lentes',                  // Lentes para Ciclismo
  MLA371883: 'ciclocomputadoras-y-gps', // Ciclocomputadoras
  MLA371650: 'pedales-y-trabas',        // Pedales
  MLA18091: 'luces-y-seguridad',        // Luces
  MLA78906: 'transmision',              // Piñones (colapsa la granularidad de ML, ver arriba)

  // ── Segunda tanda (hasta ~80% del catálogo), decidida por José ─────────────────────────────────────────
  MLA78904: 'asientos',                 // Asientos
  MLA371728: 'transmision',             // Cajas Pedaleras
  MLA371727: 'transmision',             // Plato Palanca
  MLA371730: 'transmision',             // Cadenas
  MLA371411: 'hidratacion',             // Caramañolas
  MLA371936: 'transmision',             // Descarriladores Traseros
  MLA341702: 'horquillas',              // Horquillas
  MLA371518: 'cintas-y-punos',          // Manoplas
  MLA416573: 'rodillos',                // Rodillos
  MLA371624: 'cubiertas-y-camaras',     // Cámaras de Bicicleta
  MLA371623: 'ruedas',                  // Ruedas de Bicicleta
  MLA416575: 'selladores',              // Selladores
  // DEUDA conocida de `Selladores` (D15: los insumos tubeless se quedan con las cubiertas): la categoría de ML es un
  // balde. De sus 32 modelos, por título 25 son sellador de verdad y 7 son insumos tubeless (cinta, válvulas, kits de
  // conversión); sólo 8 están también en Woo. Se mantiene `selladores` y los 7 se corrigen a mano al clasificar los
  // modelos. Bajar el mapeo al padre para salvar 7 degradaría 25: no es una mejora pendiente, es la decisión.
  // El informe de cobertura marcaba 4 y la deuda es de 7: los otros 3 son sólo de ML, así que ningún canal los
  // contradice y nada los señala (ver el comentario de `Cobertura` en informe-taxonomia.ts).
  MLA371951: 'frenos',                  // Pastillas
  MLA432979: 'infladores-y-herramientas', // Kits de Extractoras
  MLA371938: 'transmision',             // Shifters
  MLA78907: 'transmision',              // Platos
  MLA371517: 'direccion',               // Manubrios
  // La ÚNICA de la tanda cuya clave no se deduce del nombre. «Camisetas y Remeras» es genérica, pero se leyeron
  // los 27 títulos de los modelos: 26 son ropa técnica de ciclismo («Jersey Ciclismo Funkier», «Primera Piel
  // Santini», «BASE LAYER») y el único que dice «urbana» dice también «ciclista». Por eso va a `jerseys-y-calzas`
  // y no a `remeras` (que en Woo es casual).
  MLA429722: 'jerseys-y-calzas',        // Camisetas y Remeras
  MLA371410: 'cintas-y-punos',          // Cintas para Manubrio
  // `Lubricantes` (MLA429032, de la primera tanda) va a `lubricantes` y NO al padre, con una DEUDA conocida: ML no
  // tiene categoría de grasas ni de líquido de frenos (sus hermanas, bajo MLA371402, son Centradores, Corta
  // Cadenas, Multifunción, Kits, Limpiadores de Cadena, Llaves y Otras Herramientas), así que su `Lubricantes` es un
  // balde con tres cosas que nuestro árbol separa; para José `LUBRICANTES` es lubricante de cadena. De sus 89
  // modelos, 66 no están en Woo, y por título 49 son lubricante, 12 dicen «grasa» y 5 no se sabe. Esos 12 quedan en
  // `LUBRICANTES` siendo grasas y se corrigen a mano cuando se clasifiquen los modelos (paso que todavía no existe);
  // se detectan porque el título dice «grasa». Anotado acá para que nadie lo descubra por casualidad.
};

/**
 * Categorías de ML decididas como SIN EQUIVALENCIA en el árbol propio, con el motivo (que se escribe en la base,
 * `catalog.channel_category_sin_equivalencia`, para poder leerlo sin abrir el repo). No son «fuera del árbol»
 * (eso es FUERA_DEL_ARBOL, de Woo) ni están mapeadas: son baldes que no significan una categoría sino «no sé», y
 * mapearlas sería inventar información que ML no dio. Decisión de José.
 */
export const SIN_EQUIVALENCIA_ML: Record<string, string> = {
  MLA78908: 'Otros Repuestos (39 modelos): balde de ML que no nombra una categoría; mapearla a un nodo inventaría información que ML no dio. Sus modelos se clasifican a mano.',
  MLA458068: 'Productos no categorizados (37 modelos): significa «no sé» y no una categoría; mapearla a un nodo inventaría información que ML no dio. Sus modelos se clasifican a mano.',
};
