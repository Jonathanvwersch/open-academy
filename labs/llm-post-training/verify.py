import argparse
from datetime import datetime, timezone
import importlib.util
import json
import math
import os
from pathlib import Path
import sys


os.environ["OPENBLAS_NUM_THREADS"] = "1"
ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load Python module from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser(description="Verify the llm-post-training project offline.")
    parser.add_argument("--implementation", type=Path, default=ROOT / "work" / "post_training.py")
    parser.add_argument("--output", type=Path, default=ROOT / "work" / "results.json")
    args = parser.parse_args()
    suite = load_module(ROOT / "tests" / "checks.py", "post_training_checks")
    try:
        model = load_module(args.implementation.resolve(), "post_training_candidate")
    except Exception as error:
        # All failure IDs stay uploadable under the project's declared test schema.
        class BrokenModule:
            def __getattr__(self, name):
                raise RuntimeError(f"Load implementation: {load_error}")
        load_error = f"{type(error).__name__}: {error}"
        model = BrokenModule()
    checks, metrics = suite.run_checks(model)
    result = {
        "project": "llm-post-training",
        "version": 1,
        "tests": checks,
        "metrics": {name: value for name, value in metrics.items() if math.isfinite(value)},
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    passed = sum(check["passed"] for check in checks)
    print(f"{passed}/{len(checks)} checks passed")
    for check in checks:
        print(f"{'PASS' if check['passed'] else 'FAIL'} {check['id']}: {check['message']}")
    print(f"Metrics: {metrics}")
    print(f"Results written to {output}")
    return 0 if checks and passed == len(checks) else 1


if __name__ == "__main__":
    raise SystemExit(main())
