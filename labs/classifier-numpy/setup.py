from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parent
destination = ROOT / "work" / "classifier.py"
destination.parent.mkdir(parents=True, exist_ok=True)
if destination.exists():
    raise SystemExit("work/classifier.py already exists; keeping your work.")
shutil.copy2(ROOT / "starter" / "classifier.py", destination)
print(f"Copied starter to {destination}")
