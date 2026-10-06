import subprocess
php="require '/var/www/html/wp-load.php'; if(getenv('FUSION_MANAGEMENT_MODE')!=='validation')exit(1); update_option('blogname','Fusion Bikes'); echo 'Brand title restored in private runtime',PHP_EOL;"
subprocess.run(['docker','exec','fusion-management-migration-php-1','php','-r',php],check=True,capture_output=True)
print('Private view title updated')
