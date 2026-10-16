from pathlib import Path
import sqlite3,json,subprocess
p=Path('/opt/fusion-management-migration/directory-cache/directory.sqlite')
db=sqlite3.connect(f'file:{p}?mode=ro',uri=True)
orders=[json.loads(r[0]) for r in db.execute('SELECT data FROM orders')];products=set();variations=set()
for o in orders:
 for i in o['items']:
  if i.get('product_id'):products.add(i['product_id'])
  if i.get('variation_id'):variations.add(i['variation_id'])
print(json.dumps({'orders':len(orders),'refund_orders':sum(bool(o['refunds']) for o in orders),'products':len(products),'variations':len(variations),'statuses':dict(db.execute("SELECT json_extract(data,'$.status'),COUNT(*) FROM orders GROUP BY 1")),'currencies':dict(db.execute("SELECT json_extract(data,'$.currency'),COUNT(*) FROM orders GROUP BY 1")),'last_snapshot':dict(db.execute('SELECT key,value FROM state'))}));db.close()
