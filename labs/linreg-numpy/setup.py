import argparse
from pathlib import Path
import shutil


ROOT = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description="Copy starter files without replacing learner work.")
parser.add_argument("--force", action="store_true", help="Replace existing learner files with the starter.")
args = parser.parse_args()
work = ROOT / "work"
work.mkdir(exist_ok=True)
for name in ['linreg.py', 'plot.py']:
    destination = work / name
    if destination.exists() and not args.force:
        print(f"Keeping existing {destination}; use --force to replace it.")
        continue
    shutil.copy2(ROOT / "starter" / name, destination)
    print(f"Copied starter implementation to {destination}")
