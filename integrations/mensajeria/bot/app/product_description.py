"""Exact-ID description lookup via the existing signed WordPress bridge."""
import threading
import time
from urllib.parse import urlsplit

from .clients import post_wordpress, RemoteServiceError
from .config import get_settings

_cache={}
_lock=threading.Lock()
TTL=120


def fetch_product_description(product_id):
    if isinstance(product_id,bool) or not str(product_id).isdigit() or int(product_id)<=0:
        raise ValueError('invalid_product_id')
    product_id=int(product_id)
    settings=get_settings()
    if not settings.api_key or not settings.callback_secret:
        raise RemoteServiceError('description_bridge_not_configured')
    base=settings.wordpress_base_url.rstrip('/')
    key=(base,product_id)
    now=time.monotonic()
    with _lock:
        cached=_cache.get(key)
        if cached and now-cached[0]<TTL:return dict(cached[1])
    result=post_wordpress(base+'/wp-json/fusion-chat/v1/catalog/description',{'product_id':product_id},timeout=8.0)
    product=result.get('product') if isinstance(result,dict) else None
    if not isinstance(result,dict) or result.get('ok') is not True or not isinstance(product,dict) or type(product.get('id')) is not int or product['id']!=product_id:
        raise RemoteServiceError('description_product_mismatch')
    description=product.get('description')
    if not isinstance(description,str) or len(description)>20000:
        raise RemoteServiceError('invalid_description')
    url=str(product.get('url') or '')
    try:parsed=urlsplit(url);origin=urlsplit(base)
    except ValueError:raise RemoteServiceError('invalid_description_url')
    if parsed.scheme not in {'http','https'} or parsed.netloc!=origin.netloc or parsed.username or parsed.password or len(url.encode('utf-8'))>2048:
        raise RemoteServiceError('invalid_description_url')
    safe={'id':product_id,'description':description,'url':url,
          'description_truncated':product.get('description_truncated') is True}
    with _lock:
        if len(_cache)>=256:_cache.pop(next(iter(_cache)))
        _cache[key]=(now,safe)
    return dict(safe)
