"""Shared, conservative stock checks for recommendations and consultations."""
from decimal import Decimal, InvalidOperation


def confirmed_stock(item, flag):
    if item.get(flag) is not True:return False
    if item.get('stock_status') in {'outofstock', 'onbackorder'}:return False
    quantity = item.get('stock_quantity')
    if quantity is None:return True
    try:
        quantity = Decimal(str(quantity))
        return quantity.is_finite() and quantity > 0
    except InvalidOperation:return False


def available_product(product):
    if not confirmed_stock(product, 'in_stock'):return None
    variants = product.get('variations') or []
    if variants:
        available = [v for v in variants if confirmed_stock(v, 'is_in_stock')]
        return dict(product, variations=available) if available else None
    return product
