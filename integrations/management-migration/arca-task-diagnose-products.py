from pathlib import Path
import importlib.util,sqlite3,subprocess,json
spec=importlib.util.spec_from_file_location('bridge','/opt/fusion-arca-egress/arca-source.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
try:
 rows=m.products([70394]);print({'root_lookup':True,'rows':len(rows),'keys':list(rows[0]) if rows else []})
except Exception as e:print(type(e).__name__,str(e))
print(subprocess.check_output(['namei','-l',m.CATALOGUE],text=True))
db=sqlite3.connect('file:'+m.CATALOGUE+'?mode=ro',uri=True)
v=db.execute('SELECT categorias_json FROM catalogo_cache WHERE id_woo=70394').fetchone();print('categories_shape',v)
