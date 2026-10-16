"""Minimal signed order lookup. No order cache or personal data in logs."""
import re
from .clients import post_wordpress, RemoteServiceError
from .config import get_settings


def fetch_order_status(order_number, email):
    number=str(order_number)
    if not re.fullmatch(r'[1-9][0-9]{0,17}',number):raise ValueError('invalid_order_number')
    if not isinstance(email,str) or len(email)>254 or not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+',email):raise ValueError('invalid_order_email')
    settings=get_settings()
    if not settings.api_key or not settings.callback_secret:raise RemoteServiceError('order_bridge_not_configured')
    result=post_wordpress(settings.wordpress_base_url.rstrip('/')+'/wp-json/fusion-chat/v1/orders/status',
                          {'order_number':number,'email':email.strip().lower()},timeout=10.0)
    if not isinstance(result,dict) or result.get('ok') is not True or type(result.get('found')) is not bool:
        raise RemoteServiceError('invalid_order_response')
    if result['found'] is False:return None
    order=result.get('order')
    if not isinstance(order,dict) or order.get('number')!=number:raise RemoteServiceError('order_number_mismatch')
    status=order.get('status');code=order.get('tracking_code');url=order.get('tracking_url')
    if not isinstance(status,str) or not re.fullmatch(r'[a-z0-9_-]{1,60}',status):raise RemoteServiceError('invalid_order_status')
    if not isinstance(code,str) or not isinstance(url,str):raise RemoteServiceError('invalid_order_tracking')
    if code:
        if not re.fullmatch(r'[A-Za-z0-9-]{5,64}',code) or url!='https://www.andreani.com/envio/'+code:
            raise RemoteServiceError('invalid_order_tracking')
    elif url:raise RemoteServiceError('invalid_order_tracking')
    return {'number':number,'status':status,'tracking_code':code,'tracking_url':url}
