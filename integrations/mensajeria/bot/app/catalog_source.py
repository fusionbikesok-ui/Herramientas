"""Fresh local snapshot, preserving every variant and product identity."""
from .config import get_settings
from .catalog_sqlite import _load_snapshot


def load_products():
    settings=get_settings()
    rows,status=_load_snapshot(settings.catalog_sqlite_path,settings.wordpress_base_url,
                               settings.catalog_sqlite_max_age_seconds)
    if not status.get('fresh'):
        raise ValueError('catalog_not_fresh')
    result=[]
    for p in rows:
        clean={k:v for k,v in p.items() if not k.startswith('_')}
        clean['variations']=[{k:v for k,v in v.items() if not k.startswith('_')}
                             for v in p.get('variations') or []]
        result.append(clean)
    return result
