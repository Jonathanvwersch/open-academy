from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parent
destination = ROOT / "work" / "pca.py"
destination.parent.mkdir(parents=True, exist_ok=True)
if destination.exists():
    raise SystemExit("work/pca.py already exists; move it before creating a fresh starter.")
shutil.copy2(ROOT / "starter" / "pca.py", destination)
print(f"Copied starter to {destination}")
