"""Build narrowly scoped private-runtime JS overlays from the supplied plugin sources."""
from pathlib import Path
import re,sys
w=Path(__file__).parent;r=Path(sys.argv[2]) if len(sys.argv)>2 else w/'management-migration';assets=r/'assets'
sources=Path(sys.argv[1]) if len(sys.argv)>1 else w/'plugin-sources'
def replace_once(value,old,new):
    assert value.count(old)==1, old[:80]
    return value.replace(old,new,1)
p=sources/'fusion-bikes-pos-pro-v3.4.6-beta.2-b3e8b3bc4b/fusion-bikes-pos-v2/assets/pos.js'
s=p.read_text(encoding='utf-8')
s=replace_once(s,'function showProducts(rows){',"function showProducts(rows){if(Array.isArray(rows)&&rows.every(p=>p._local)){lastCatalog=rows;$('#product-results').innerHTML=FusionLocalCatalog.render(rows);$('#product-results').onclick=null;return;}")
s=replace_once(s,'function addProduct(p){',"function addProduct(p){if(p._local){showProducts([p]);$('#search-status').textContent='Producto encontrado en el catálogo local · solo consulta';return;}")
(assets/'pos.js').write_text(s,encoding='utf-8')
p=sources/'fusion-taller-v0.2.0-beta.1-7b81c19ae8/fusion-taller/assets/app.js'
s=p.read_text(encoding='utf-8')
s=replace_once(s,'        productRows=data.rows;',"        productRows=data.rows;\n        if(data.local_catalog){box.innerHTML=FusionLocalCatalog.render(data.rows);return;}")
s=replace_once(s,'Buscar en WooCommerce','Buscar en el catálogo local')
s=replace_once(s,'Precios base del POS / contado en ARS. Elegí la variante exacta. El presupuesto consulta stock; el cobro y su descuento se registran en el POS.','Consulta del catálogo sincronizado en el VPS. Cantidad registrada y precio web de referencia; agregar productos y guardar cambios aún no está habilitado.')
(assets/'taller.js').write_text(s,encoding='utf-8')
p=sources/'fusion-facturacion-arca-v0.1.0-beta.37-b4258d5b13/fusion-facturacion-arca/assets/admin.js'
s=p.read_text(encoding='utf-8')
s=replace_once(s,'  function productResults(){',"  function productResults(){if(results.every(p=>p._local))return FusionLocalCatalog.render(results)+`<div class=\"fa-search-footer\"><small>${results.length} productos locales</small>${productHasMore?'<button type=\"button\" class=\"fa-btn secondary\" data-action=\"more-products\">Cargar más productos</button>':''}</div>`;")
s=replace_once(s,"[['all','Todos'],['instock','Con stock'],['outofstock','Sin stock / a pedido']]","[['all','Todos'],['instock','Cantidad positiva'],['outofstock','Cantidad cero o negativa']]")
nav_start=s.index('${config.can_bulk?`<button data-tab="bulk"')
nav_end=s.index('${FusionArca.admin?',nav_start)
s=s[:nav_start]+'''<button data-tab="ml" class="${tab==='ml'?'active':''}">${icon('box')} Mercado Libre</button>'''+s[nav_end:]
s=replace_once(s,"if(tab==='ml'&&config.can_bulk&&config.bulk_unlocked)loadMl()","if(tab==='ml')loadMl()")
start=s.index('  function mlShell(){');end=s.index('  async function customerMl(',start)
s=s[:start]+(assets/'ml-readonly.js').read_text(encoding='utf-8')+'\n'+s[end:]
s=replace_once(s,'Busca también ventas que todavía no estén cargadas.','Busca entre las ventas del historial copiado.')
s=replace_once(s,'Los filtros incluyen todas las ventas sincronizadas y no cambian la automatización.','Los filtros consultan únicamente el historial conservado en el VPS.')
s=replace_once(s,"if(next.number){const found=await api('ml/activity?'+new URLSearchParams({number:next.number}));if(!found.rows.length)await api('ml/lookup','POST',{number:next.number});}",'')
(assets/'facturador.js').write_text(s,encoding='utf-8')
p=r/'gateway.mjs';s=p.read_text(encoding='utf-8')
s,count=re.subn(r'const home = `[^\n]+`;','const home = readFileSync(new URL(\'./home.html\', import.meta.url), \'utf8\');',s)
assert count==1 or "const home = readFileSync" in s
p.write_text(s,encoding='utf-8')
print('Three private JS overlays and gateway Home prepared; original plugin files unchanged.')
