from pathlib import Path
import subprocess,stat
p=Path('/opt/fusion-arca-egress');assert p.is_dir() and not p.is_symlink()
print('previous_directory_mode',oct(stat.S_IMODE(p.stat().st_mode)))
p.chmod(0o755)
subprocess.run(['systemctl','restart','fusion-arca-egress.service'],check=True)
print(subprocess.check_output(['systemctl','is-active','fusion-arca-egress.service'],text=True).strip())
