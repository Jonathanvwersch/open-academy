import argparse
from pathlib import Path
import runpy
import sys


LABS = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(
        description="Run the local verifier for a project in labs/."
    )
    parser.add_argument("project", help="Project id, for example nn-from-scratch.")
    args, forwarded = parser.parse_known_args()
    project_dir = (LABS / args.project).resolve()
    try:
        project_dir.relative_to(LABS.resolve())
    except ValueError:
        parser.error("project must name a directory inside labs/")

    verifier = project_dir / "verify.py"
    if not verifier.is_file():
        parser.error(f"no verifier found for project {args.project!r}")

    sys.argv = [str(verifier), *forwarded]
    runpy.run_path(str(verifier), run_name="__main__")


if __name__ == "__main__":
    main()
