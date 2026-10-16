from pathlib import Path
import shutil,json
r=Path('/opt/fusion-management-migration');p=r/'assets/management.css';dest=Path('/opt/fusionbikes/herramientas/integrations/management-migration')
old=p.read_text();marker='/* POS active catalogue contrast */'
css='''
/* POS active catalogue contrast */
#fbpos-app .product-card{background:var(--surface2)!important;border-color:var(--border)!important;color:var(--text)!important}
#fbpos-app .product-card:hover{background:var(--surface)!important;border-color:var(--accent)!important}
#fbpos-app .product-card :is(strong,b){color:var(--text)!important}
#fbpos-app .product-card small{color:var(--muted)!important}
#fbpos-app .product-card .pos-product-image{background:#fff;border-radius:8px;object-fit:contain}
'''
if marker not in old:
 shutil.copy2(p,r/'backups/pos-ui-20261006/management.css')
 p.write_text(old.rstrip()+css)
shutil.copy2(p,dest/'assets/management.css')
note='\n\nCierre POS 2026-10-06: respaldo diario privado ampliado con snapshot consistente pos.sqlite/configuración gateway y primera ejecución verificada; borrador limpio y operación de prueba liberada. Contraste de tarjetas corregido con variables del tema; confirmaciones internas permiten limpiar/liberar la preparación.\n'
for doc in [dest/'README-POS.md',Path('/opt/fusionbikes/herramientas/docs/memory/modules/operations-vps.md')]:
 text=doc.read_text()
 if 'Cierre POS 2026-10-06' not in text:doc.write_text(text.rstrip()+note)
print(json.dumps({'catalogue_contrast_updated':True}))
