"""Bind a fresh caption to the immediately preceding attachment in this same chat."""
import re
from .storage import connection

def related_attachment(key,external_id):
    with connection() as conn:
        rows=conn.execute("""SELECT id,external_id,sender,kind,body,created_at,metadata
          FROM messages WHERE conversation_key=%s AND COALESCE(metadata->>'historical','false')!='true'
          AND (sender='customer' OR delivery_status NOT IN ('queued','sending','unknown','failed','cancelled','pending'))
          ORDER BY created_at DESC,id DESC LIMIT 5""",(key,)).fetchall()
    if len(rows)<2:return None
    current=rows[0];media=None;captions=[]
    if current['external_id']!=external_id or current['sender']!='customer' or current['kind']!='text':return None
    for row in rows:
        if row['sender']!='customer' or any(row['metadata'].get(k) is True for k in ('historical','revoked','edited')):return None
        if not 0<=(current['created_at']-row['created_at']).total_seconds()<=90:return None
        if row['kind'] in ('image','audio'):media=row;break
        if row['kind']!='text' or len(row['body'])>600:return None
        captions.insert(0,row['body'])
    if media is None:return None
    seconds=(current['created_at']-media['created_at']).total_seconds()
    if not 0<=seconds<=90 or len(current['body'])>600:return None
    # Older attachments require an explicit reference, avoiding unrelated questions.
    if seconds>15 and not re.search(r'\b(?:esa|ese|esta|este|foto|imagen|audio|escucha|escuchá)\b',current['body'],re.I):return None
    return {'external_id':media['external_id'],'kind':media['kind'],'caption':'\n'.join(captions)}
