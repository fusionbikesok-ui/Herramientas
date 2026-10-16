from pathlib import Path
import gzip,json,shutil
root=Path('/opt/fusion-management-migration')
assert (root/'.task-owner').read_text()=='fusion-management-migration-20261004'
area=(root/'home-navigation').resolve()
result=json.loads((area/'result.json').read_text());assert result['success']
for name in ['test-result.json','recheck-result.json']:
    p=area/'qa2'/name
    if p.exists():
        with gzip.open(area/(name+'.gz'),'wb') as out:out.write(p.read_bytes())
for name in ['qa','qa2']:
    p=area/name
    assert not p.is_symlink() and p.resolve().parent==area and p.resolve().is_relative_to(root.resolve())
    if p.exists():shutil.rmtree(p)
print('Copias temporales eliminadas; respaldos, candidato y resultados conservados.')
