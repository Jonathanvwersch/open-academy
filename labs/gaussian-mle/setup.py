from pathlib import Path
import shutil


ROOT = Path(__file__).resolve().parent
work = ROOT / "work"
work.mkdir(parents=True, exist_ok=True)
for name in ("gaussian.py", "report.py"):
    shutil.copy2(ROOT / "starter" / name, work / name)
print(f"Copied starter files to {work}")
