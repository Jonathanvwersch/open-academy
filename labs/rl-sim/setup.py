from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parent
work = ROOT / "work"
work.mkdir(parents=True, exist_ok=True)
for source in (ROOT / "starter").iterdir():
    if source.is_file():
        destination = work / source.name
        if destination.exists():
            print(f"Kept existing work file at {destination}")
        else:
            shutil.copy2(source, destination)
            print(f"Copied starter to {destination}")
