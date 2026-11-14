from pathlib import Path
import shutil


ROOT = Path(__file__).resolve().parent
work = ROOT / "work"
work.mkdir(parents=True, exist_ok=True)
for name in ("gaussian.py", "report.py"):
    destination = work / name
    if destination.exists():
        print(f"Kept existing work file at {destination}")
    else:
        shutil.copy2(ROOT / "starter" / name, destination)
        print(f"Copied starter to {destination}")
