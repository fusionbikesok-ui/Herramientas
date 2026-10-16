"""Photo observations propose identities; fresh stock and web prices remain authoritative."""
import json
from .catalog_source import load_products
from .catalog_words import product_kind
from .catalog_stock import available_product
from .ai import BotDecision

def candidates():
    # No customer data, stock or prices are sent in the visual candidate index.
    products=[p for p in load_products() if product_kind(p)=='bicicleta']
    rows=[{'id':p['id'],'name':p['name']} for p in products]
    body=json.dumps(rows,ensure_ascii=False)
    return (body,{p['id'] for p in products}) if len(body.encode('utf8'))<=60_000 else ('[]',set())

def decision(result,department,caption=''):
    if result.get('category')!='product':return None
    ids=result.get('candidate_ids') or []
    if not ids:return None
    try:products=[p for p in load_products() if p['id'] in ids][:3]
    except Exception:return None
    if not products:return None
    from .catalog_flow import _parse
    requested_size=None
    for line in caption.splitlines():
        requested_size=_parse(line,set(),{'kind':'bicicleta'}).get('size') or requested_size
    blocks=['Por la foto, estas son posibles coincidencias de nuestro catálogo. La imagen sola no confirma el modelo ni la versión:']
    for p in products:
        available=available_product(p)
        if available and requested_size:
            variations=[v for v in available.get('variations',[]) if str((v.get('attributes') or {}).get('attribute_pa_talle') or (v.get('attributes') or {}).get('attribute_talle') or '').upper()==requested_size]
            available=dict(available,variations=variations) if variations else None
        lines=['• '+p['name'],p['url']]
        if available:
            sizes=[]
            for v in available.get('variations') or []:
                a=v.get('attributes') or {}
                variant_size=str(a.get('attribute_pa_talle') or a.get('attribute_talle') or a.get('size') or '')
                color=str(a.get('attribute_pa_color') or a.get('attribute_color') or a.get('color') or '')
                label=' / '.join(x for x in [variant_size,color] if x)
                if label and label not in sizes:sizes.append(label)
            lines.append('En el catálogo figura stock'+(': '+', '.join(sizes[:8]) if sizes else '')+'.')
        else:lines.append('El catálogo no muestra stock disponible de esta referencia'+(' en talle '+requested_size if requested_size else '')+'.')
        blocks.append('\n'.join(lines))
    blocks.append('¿Es ese el modelo que estás buscando? Así te confirmo la variante y el precio vigente.')
    return BotDecision('\n\n'.join(blocks),False,department,'Candidatos visuales por confirmar','normal')
