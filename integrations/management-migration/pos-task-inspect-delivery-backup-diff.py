from pathlib import Path
import difflib
base=Path('/opt/fusion-management-migration/backups/arca-delivery-20261006T133734Z/scripts/arca-backup.py')
source=Path('/opt/fusionbikes/herramientas/integrations/management-migration/scripts/arca-backup.py')
print(''.join(difflib.unified_diff(base.read_text().splitlines(True),source.read_text().splitlines(True),fromfile='pre-deploy runtime',tofile='canonical')))
