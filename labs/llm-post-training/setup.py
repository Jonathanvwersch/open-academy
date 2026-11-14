from pathlib import Path
import shutil


ROOT = Path(__file__).resolve().parent
destination = ROOT / "work" / "post_training.py"
destination.parent.mkdir(parents=True, exist_ok=True)
if destination.exists():
    print(f"Kept existing implementation at {destination}")
else:
    shutil.copy2(ROOT / "starter" / "post_training.py", destination)
    print(f"Copied starter to {destination}")
