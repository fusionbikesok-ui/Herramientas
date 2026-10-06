"""Durable native-chat QA worker; no WordPress, WhatsApp, AI or catalogue calls."""
import logging
import time

from .ai import BotDecision
from .native_store import claim_job, fail_job, finish_job, initialize, job_input

logger = logging.getLogger('fusion.native.qa')


def simulated_decision(text: str) -> BotDecision:
    handoff = any(word in text.casefold() for word in ('persona', 'asesor', 'humano'))
    reply = ('Tu consulta quedó pendiente para un asesor de prueba.' if handoff else
             'Recibí tu mensaje de prueba. Podés pedir un asesor para ensayar la atención humana.')
    return BotDecision(reply, handoff, 'ventas', 'Solicitud de asesor de prueba' if handoff else '')


def process_one() -> bool:
    job = claim_job()
    if not job:
        return False
    try:
        data = job_input(job)
        finish_job(job, simulated_decision(data['body']))
    except Exception as exc:
        # Store only exception class, never message bodies, URLs or credentials.
        fail_job(job, type(exc).__name__)
        logger.error('Native QA job failed: %s', type(exc).__name__)
    return True


if __name__ == '__main__':
    initialize()
    logging.basicConfig(level=logging.INFO)
    while True:
        if not process_one():
            time.sleep(0.5)
