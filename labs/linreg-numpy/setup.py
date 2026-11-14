from pathlib import Path
import shutil

root = Path(__file__).parent
work = root / "work"
work.mkdir(parents=True, exist_ok=True)
for name in ("linreg.py", "plot.py"):
    destination = work / name
    if destination.exists():
        print(f"Kept existing work file at {destination}")
    else:
        shutil.copy2(root / "starter" / name, destination)
        print(f"Copied starter to {destination}")
