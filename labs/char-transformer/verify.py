import argparse
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser(description="Verify the character transformer locally.")
    parser.add_argument("--implementation", type=Path, default=ROOT / "work" / "model.py")
    parser.add_argument("--output", type=Path, default=ROOT / "work" / "results.json")
    args = parser.parse_args()
    suite = load(ROOT / "tests" / "checks.py", "char_checks")
    try:
        candidate = load(args.implementation.resolve(), "char_candidate")
    except Exception as error:
        class Unavailable:
            def __getattr__(self, name):
                raise RuntimeError(f"Could not load implementation: {failure}")
        failure = f"{type(error).__name__}: {error}"
        candidate = Unavailable()
    checks, metrics = suite.run_checks(candidate)
    result = {"project": "char-transformer", "version": 1, "tests": checks,
              "metrics": metrics, "generated_at": datetime.now(timezone.utc).isoformat()}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    passed = sum(check["passed"] for check in checks)
    print(f"{passed}/{len(checks)} checks passed")
    for check in checks:
        state = "PASS" if check["passed"] else "FAIL"
        print(f"{state} {check['id']}: {check['message']}")
    print(f"Metrics: {metrics}")
    print(f"Results written to {args.output}")
    return 0 if passed == len(checks) else 1


if __name__ == "__main__":
    raise SystemExit(main())
