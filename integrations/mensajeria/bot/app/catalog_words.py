"""Canonical product vocabulary. Only explicit aliases, no fuzzy brand guessing."""
import re
from .routing import normalize

ALIASES = {
 'rudy project':'rudyproject','rudy-project':'rudyproject','rudy':'rudyproject',
 'super caliber':'supercaliber',
 'rock shox':'rockshox','mountain bike':'mtb','mountainbike':'mtb','mountain':'mtb',
 'montana':'mtb','bicis':'bicicleta','bici':'bicicleta','bicicletas':'bicicleta',
 'carretera':'ruta','road bike':'ruta','roadbike':'ruta',
 'manoplas':'puno','manopla':'puno','punos':'puno','cuernitos':'cuernito','cuernos':'cuernito','cuerno':'cuernito',
 'bar ends':'cuernito','bar end':'cuernito','barends':'cuernito',
 'cascos':'casco','lentes':'lente','anteojos':'lente','anteojo':'lente','gafas':'lente','gafa':'lente',
 'calzas':'calza','culotte':'calza','culottes':'calza','culote':'calza','culotes':'calza',
 'guantes':'guante','zapatillas':'zapatilla','jerseys':'jersey','maillot':'jersey','maillots':'jersey',
 'camperas':'campera','chaquetas':'campera','chaqueta':'campera','chalecos':'chaleco',
 'medias':'media','remeras':'remera','buzos':'buzo','shorts':'short','perneras':'pernera',
 'cubiertas':'cubierta','neumaticos':'cubierta','neumatico':'cubierta','camaras':'camara',
 'asientos':'asiento','sillin':'asiento','sillines':'asiento','pedales':'pedal',
 'horquillas':'horquilla','cadenas':'cadena','frenos':'freno','pastillas':'pastilla',
 'discos':'disco','pinones':'pinon','cassettes':'cassette','platos':'plato',
 'ruedas':'rueda','llantas':'rueda','llanta':'rueda','aros':'rueda','aro':'rueda',
 'manubrios':'manubrio','manillares':'manubrio','manillar':'manubrio',
 'infladores':'inflador','bombas':'inflador','botellas':'caramagnola','caramagnolas':'caramagnola',
 'luces':'luz','rodillos':'rodillo','herramientas':'herramienta','extractores':'extractor',
 'tapones':'tapon','valvulas':'valvula','repuestos':'repuesto','accesorios':'accesorio',
 'ciclocomputadoras':'ciclocomputadora','ciclocomputadores':'ciclocomputadora',
 'portacaramanolas':'portacaramañola','portacaramanolas':'portacaramañola',
 'urbanas':'ciudad','urbana':'ciudad','urbanos':'ciudad','urbano':'ciudad','paseo':'ciudad',
 'infantiles':'infantil','ninos':'infantil','ninas':'infantil','nino':'infantil','nina':'infantil',
 'chicos':'infantil','chicas':'infantil','nenes':'infantil','nenas':'infantil',
}
TYPES = set('cuernito puno bicicleta casco lente calza guante zapatilla jersey campera chaleco media remera buzo short pernera cubierta camara asiento pedal horquilla cadena freno pastilla disco pinon cassette plato rueda manubrio inflador caramagnola luz rodillo herramienta extractor tapon valvula ciclocomputadora'.split())
SUBTYPES = {'mtb','ruta','gravel','ciudad','infantil'}
NOISE = set('tendran x dudas acaso hola buenas buen dia tardes noches que tal tienen tenes tiene hay quiero quisiera busco buscando estoy saber si la el los las un una unos unas de del para por favor me podes podrias mostrar mostrame pasame ver info informacion sobre opciones disponible disponibles stock precio precios y o en con'.split())
COLORS = set('negro negra blanco blanca rojo roja azul verde amarillo amarilla gris naranja rosa violeta marron teal plata celeste'.split())


def words(text):
    value=normalize(str(text or ''))
    for a,b in sorted(ALIASES.items(),key=lambda pair:-len(pair[0])):
        value=re.sub(r'\b'+re.escape(a)+r'\b',b,value)
    return re.findall(r'[a-z0-9]+(?:[.-][a-z0-9]+)*',value)


def meaningful(text):
    return [w for w in words(text) if w not in NOISE]


def phrase(text):
    return ' '.join(meaningful(text))


def product_kind(product):
    name=words(product.get('name',''))
    # Product's principal noun wins: extractor de cubiertas is an extractor.
    return next((w for w in name if w in TYPES),None)
