import subprocess
print(subprocess.check_output(['journalctl','-u','fusion-arca-egress.service','-n','35','--no-pager'],text=True))
