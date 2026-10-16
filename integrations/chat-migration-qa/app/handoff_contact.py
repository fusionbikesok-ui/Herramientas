"""Collect a callback phone before pausing the bot for a human handoff."""
import re
from dataclasses import replace
from .ai import BotDecision
from .routing import normalize

QUESTIONS={
    'ventas':'Antes de dejar tu consulta con un asesor de ventas, ¿me pasás tu teléfono o WhatsApp con código de área? Así te escribimos cuando retomemos la atención en el local.',
    'posventa_taller':'Antes de dejar tu consulta con un asesor de posventa, ¿me pasás tu teléfono o WhatsApp con código de área? Así te escribimos cuando retomemos la atención en el local.',
}

def body(row):return str(row.get('body') or row.get('text') or row.get('content') or '')
def role(row):return str(row.get('sender') or row.get('role') or '')

def previous(history,text):
    rows=list(history or [])
    if rows and role(rows[-1]) in {'customer','user'} and body(rows[-1]).strip()==text.strip():rows.pop()
    return rows

def phone_number(value):
    """Keep the supplied country/area code; never guess a missing area code."""
    if not isinstance(value,str) or len(value)>80:return ''
    value=value.strip()
    if not re.fullmatch(r'\+?[0-9() .-]+',value):return ''
    digits=re.sub(r'\D','',value)
    if not 10<=len(digits)<=15 or len(set(digits))<3:return ''
    if value.startswith('+'):return '+'+digits
    if digits.startswith('00') and len(digits)>=12:return '+'+digits[2:]
    if digits.startswith('54') and len(digits) in {12,13}:return '+'+digits
    # Common Argentine mobile notation: 0351 15 1234567 -> 3511234567.
    if len(digits)==13 and digits.startswith('0'):digits=digits[1:]
    if len(digits)==12:
        local=re.fullmatch(r'(\d{2,4})15(\d{6,8})',digits)
        if local and len(local[1]+local[2])==10:return local[1]+local[2]
    if len(digits)==11 and digits.startswith('0'):return digits[1:]
    if len(digits)>10:return '+'+digits
    return digits

def supplied_phone(text,requested=False):
    # Only phone-shaped input, never an order, price, height or payment identifier.
    value=normalize(text)
    label=re.search(r'\b(?:whats?app|wsp|telefono|tel|celular|celu|llamame|escribime)\b',value)
    if label:
        text=text[label.end():];value=normalize(text)
    if re.search(r'\b(?:pedido|orden|tracking|seguimiento|cbu|cvu|cuit|dni|tarjeta|cuenta|codigo|precio|pesos|altura|mido|cm)\b',value) or '@' in value:return ''
    if not requested and not label:return ''
    candidates=re.findall(r'(?<!\w)\+?\d[\d() .-]{7,30}\d(?!\w)',text)
    numbers=list(dict.fromkeys(n for candidate in candidates if (n:=phone_number(candidate))))
    return numbers[0] if len(numbers)==1 else ''

def known_phone(text,history,conversation):
    conversation=conversation or {}
    if str(conversation.get('channel') or '')=='whatsapp':
        raw=str(conversation.get('external_user_id') or '')
        number=phone_number('+'+raw.lstrip('+')) if raw else ''
        if number:return number
    number=supplied_phone(text) or phone_number(str(conversation.get('customer_phone') or ''))
    if number:return number
    remembered='';last_bot=''
    for row in previous(history,text):
        if role(row) in {'bot','assistant'}:last_bot=body(row)
        elif role(row) in {'customer','user'}:
            number=supplied_phone(body(row),requested=any(q in last_bot for q in QUESTIONS.values()))
            if number:remembered=number
    return remembered

def contact_followup(text,history,conversation=None):
    rows=previous(history,text)
    last=next((body(r) for r in reversed(rows) if role(r) in {'bot','assistant'}),'')
    department=next((dept for dept,q in QUESTIONS.items() if q in last),None)
    if department is None:return None
    value=normalize(text).strip(' .!?¿¡')
    if re.search(r'\b(?:seguir|continuar) (?:aca|por aca|con vos|con el bot)|no (?:quiero|necesito) (?:un )?asesor',value):
        return BotDecision('Dale, seguimos por acá. ¿En qué más te puedo ayudar?',False,department,'Cliente continúa con el bot')
    if re.fullmatch(r'no(?: gracias| por ahora)?',value) or re.search(r'\b(?:no quiero (?:dar|pasar|dejar)|prefiero no|no (?:lo )?tengo|no me (?:llamen|escriban))\b',value):
        return BotDecision('No hay problema. Dejo tu consulta para un asesor; podés continuar por este chat.',True,department,'Cliente prefiere continuar sin teléfono')
    # A new question must not be consumed as a malformed telephone number.
    number=supplied_phone(text,requested=True)
    if number:
        return BotDecision('Gracias, guardé tu teléfono de contacto. Dejo tu consulta para un asesor de '+('posventa' if department=='posventa_taller' else 'ventas')+'. Te escribimos cuando retomemos la atención en el local.',True,department,'Contacto recibido para atención humana','normal',number)
    if re.fullmatch(r'[+0-9() .-]+',value) or re.fullmatch(r'(?:mi )?(?:telefono|whatsapp|celular|celu)(?: es)?[: ]*[+0-9() .-]*',value):
        return BotDecision('Pasame el número completo, incluido el código de área.\n\n'+QUESTIONS[department],False,department,'Esperando teléfono para derivar')
    return None


def finalize_handoff(decision,text,history,conversation=None):
    if decision.contact_phone:return decision
    reply_value=normalize(decision.reply)
    promised=bool(re.search(r'\bte (?:derivo|paso|comunico) (?:a |con |para )',reply_value)) and not re.search(r'\b(?:si (?:queres|preferis)|no te (?:derivo|paso|comunico))\b',reply_value)
    if not decision.handoff and not promised:return decision
    # A refusal already completed the contact dialogue; do not ask again.
    if decision.reason=='Cliente prefiere continuar sin teléfono':return decision
    department=decision.department if decision.department in QUESTIONS else 'ventas'
    number=known_phone(text,history,conversation)
    reply=decision.reply.strip()
    # Keep verified information, but ask only for contact at the handoff step.
    reply=re.sub(r'¿[^?]*\?','',reply).strip()
    if number:
        return replace(decision,reply=reply+'\n\nYa tenemos tu teléfono de contacto. Te escribimos cuando retomemos la atención en el local.',handoff=True,department=department,contact_phone=number)
    reply=re.sub(r'(?i)\bte (?:derivo|paso|comunico)\b[^.\n]*(?:\.|$)','Un asesor va a revisar tu consulta.',reply).strip()
    return replace(decision,reply=reply+'\n\n'+QUESTIONS[department],handoff=False,department=department,reason='Esperando teléfono para derivar: '+decision.reason[:190])
