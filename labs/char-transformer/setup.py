from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parent
destination = ROOT / "work" / "model.py"
if destination.exists():
    raise SystemExit("work/model.py already exists; move it aside before resetting.")
destination.parent.mkdir(parents=True, exist_ok=True)
shutil.copy2(ROOT / "starter" / "model.py", destination)
print(f"Copied starter to {destination}")
