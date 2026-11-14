from pathlib import Path
import shutil


root = Path(__file__).resolve().parent
destination = root / "work" / "classifier.py"
destination.parent.mkdir(parents=True, exist_ok=True)
if destination.exists():
    raise SystemExit(f"Refusing to overwrite {destination}")
shutil.copy2(root / "starter" / "classifier.py", destination)
print(f"Copied starter to {destination}")
