from pathlib import Path
import shutil

root = Path(__file__).parent
work = root / "work"
work.mkdir(exist_ok=True)
shutil.copy2(root / "starter" / "linreg.py", work / "linreg.py")
shutil.copy2(root / "starter" / "plot.py", work / "plot.py")
print(f"Starter files copied to {work}")
