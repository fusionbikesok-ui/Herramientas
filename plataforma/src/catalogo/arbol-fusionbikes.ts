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

/** Un nodo del árbol propio. `clave` es estable y por RUTA: hay dos `INFLADORES` en lugares distintos. */
export interface NodoFusion {
  clave: string;
  nombre: string;
  padre: string | null;
  rubro?: 'producto' | 'servicio';
}

const hijos = (padre: string | null, nombres: Array<[string, string]>): NodoFusion[] =>
  nombres.map(([clave, nombre]) => ({ clave: padre ? `${padre}/${clave}` : clave, nombre, padre }));

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
  { clave: 'taller/services', nombre: 'SERVICES', padre: 'taller', rubro: 'servicio' },

  { clave: 'santini', nombre: 'SANTINI', padre: null },
];

/**
 * Categorías de Woo que NO mapean a un nodo porque su distinción pasó a faceta: cada una apunta al nodo que
 * la absorbe. Se mapean igual (`taxonomy_channel_map`) para que un modelo que sólo tiene esa categoría caiga
 * en el nodo padre en vez de quedar sin clasificar.
 */
export const ABSORBIDAS: Record<string, string> = {
  '119': 'componentes/cubiertas-y-camaras',   // CUBIERTAS
  '126': 'componentes/cubiertas-y-camaras',   // CAMARAS
  '96': 'componentes/cubiertas-y-camaras',    // ACCESORIOS TUBELESS
  '135': 'componentes/transmision',           // SHIFTERS
  '108': 'componentes/transmision',           // FUSIBLES
  '107': 'componentes/ruedas',                // MAZAS
  '105': 'componentes/ruedas',                // EJES PASANTES
  '130': 'componentes/direccion',             // MANUBRIOS
  '131': 'componentes/direccion',             // STEMS/AVANCES
  '129': 'componentes/asientos',              // PORTASILLAS
  '134': 'componentes/asientos',              // COLLARES DE ASIENTO
  '79': 'componentes/asientos',               // FUNDAS ASIENTO
  '839': 'componentes/horquillas',            // REPUESTOS PARA HORQUILLAS
  '132': 'componentes/pedales-y-trabas',      // CALAS / TRABAS
  '122': 'accesorios/infladores-y-herramientas', // HERRAMIENTAS
  '1209': 'accesorios/infladores-y-herramientas', // INFLADORES
  '1208': 'accesorios/fanttik',               // ASPIRADORAS
  '788': 'accesorios/ciclocomputadoras-y-gps', // POTENCIOMETROS
  '191': 'indumentaria/jerseys-y-calzas',     // CALZAS
  '193': 'indumentaria/camperas',             // CHALECOS
  // La RAÍZ `LÍQUIDOS` desaparece del árbol (TALLER la absorbe) pero sigue siendo una categoría con
  // productos propios en Woo, no sólo un contenedor: sin esta línea sus modelos quedaban sin clasificar y
  // nada protestaba. Lo encontró el chequeo de que las 82 categorías tengan destino.
  '59': 'taller',                             // LÍQUIDOS
};

/** Categorías de Woo que quedan FUERA del árbol por decisión: sus modelos van a clasificar a mano. */
export const FUERA_DEL_ARBOL: Record<string, string> = {
  '746': 'Hotsale es una colección con vigencia, no un nodo (D2)',
  '1459': 'OTROS sale del árbol; su producto se clasifica a mano',
  '260': 'QR PAGOS sale del árbol; su producto se clasifica a mano',
  '389': 'SMARTWATCH sale del árbol; su producto se clasifica a mano',
  '343': 'SERVICES se mapea al nodo de servicios bajo TALLER',
  '1518': 'Taller es la raíz TALLER del árbol propio',
  '1205': 'FANTTIK es marca Y nodo: se mapea al nodo accesorios/fanttik',
};
