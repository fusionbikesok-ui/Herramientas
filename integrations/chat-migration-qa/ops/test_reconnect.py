"""Briefly interrupt only the synthetic QA API to verify browser recovery."""
from pathlib import Path
import subprocess
import time

assert Path('/opt/fusion-chat-migration-qa/.codex-migration-qa').read_text() == 'fusion-chat-migration-20261004'
try:
    subprocess.run(['docker','stop','--time','5','fusion-chat-migration-qa-api-1'],check=True,capture_output=True,timeout=15)
    time.sleep(14)
finally:
    subprocess.run(['docker','start','fusion-chat-migration-qa-api-1'],check=True,capture_output=True,timeout=20)
print('QA API restarted after the isolated browser reconnection test')
