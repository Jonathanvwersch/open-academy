from pathlib import Path
import shutil


ROOT = Path(__file__).resolve().parent
source = ROOT / "starter" / "gradient_check.py"
destination = ROOT / "work" / "gradient_check.py"
destination.parent.mkdir(parents=True, exist_ok=True)
if destination.exists():
    raise SystemExit("work/gradient_check.py already exists. Keep your work or move it before setup.")
shutil.copy2(source, destination)
print(f"Copied starter implementation to {destination}")
