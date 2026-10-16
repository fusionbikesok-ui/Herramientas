import subprocess,json,re
db='fusion-management-migration-db-1';php='fusion-management-migration-php-1';qa='fusion_arca_qa_20261005'
def dbroot(sql):
 r=subprocess.run(['docker','exec','-i',db,'sh','-c','exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD"'],input=sql,text=True,capture_output=True)
 if r.returncode:raise RuntimeError('Database QA setup failed')
 return r.stdout
info=json.loads(subprocess.check_output(['docker','inspect',db]))[0];env=dict(x.split('=',1) for x in info['Config']['Env'] if '=' in x);user=env['MYSQL_USER'];assert re.fullmatch('[a-zA-Z0-9_]+',user)
assert qa not in dbroot('SHOW DATABASES;'),'QA database already exists'
dump=subprocess.run(['docker','exec',db,'sh','-c','exec mysqldump --no-tablespaces --single-transaction --skip-comments -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"'],capture_output=True,text=True)
assert dump.returncode==0,'Backup failed'
dbroot('CREATE DATABASE '+qa+'; GRANT ALL ON '+qa+'.* TO `'+user+'`@`%`; USE '+qa+';\n'+dump.stdout)
try:
 prefix="<?php require '/var/www/html/wp-load.php';if(DB_NAME!=='"+qa+"')throw new RuntimeException('Wrong DB');update_option('woocommerce_custom_orders_table_enabled','no');update_option('woocommerce_custom_orders_table_data_sync_enabled','no');echo 'QA database configured';"
 r=subprocess.run(['docker','exec','-i','-e','WORDPRESS_DB_NAME='+qa,php,'php'],input=prefix,text=True,capture_output=True);print(r.stdout);assert r.returncode==0,r.stderr
 r=subprocess.run(['docker','exec','-e','WORDPRESS_DB_NAME='+qa,'-e','FUSION_ARCA_MIRROR_TEST_DISPOSABLE=1',php,'php','/tmp/arca-adapter/test-wordpress.php','/var/www/html/wp-load.php'],text=True,capture_output=True,timeout=70);print(r.stdout);assert r.returncode==0,r.stderr
finally:
 dbroot('DROP DATABASE `'+qa+'`; REVOKE ALL ON `'+qa+'`.* FROM `'+user+'`@`%`;')
 print('Disposable QA database removed; live fiscal database unchanged')
