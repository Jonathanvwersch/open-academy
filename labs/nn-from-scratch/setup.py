from pathlib import Path
import shutil


ROOT = Path(__file__).resolve().parent
source = ROOT / "starter" / "nn.py"
destination = ROOT / "work" / "nn.py"
destination.parent.mkdir(parents=True, exist_ok=True)
if destination.exists():
    print(f"Kept existing implementation at {destination}")
else:
    shutil.copy2(source, destination)
    print(f"Copied starter implementation to {destination}")
