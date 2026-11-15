import argparse
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
FAILURE_TEST_IDS = ["collect-episode","returns-to-go","policy-probabilities","policy-gradient","reinforce-update","ppo-objective","ppo-gradient","reinforce-evaluation","ppo-evaluation","ppo-ratio-clip"]


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load Python module from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser(description="Verify rl-sim offline.")
    parser.add_argument("--implementation", type=Path, default=ROOT / "work" / "policy.py")
    parser.add_argument("--output", type=Path, default=ROOT / "work" / "results.json")
    args = parser.parse_args()
    try:
        model = load_module(args.implementation.resolve(), "rl_candidate")
        suite = load_module(ROOT / "tests" / "checks.py", "rl_checks")
        checks, metrics = suite.run_checks(model)
    except Exception as error:
        checks = [{"id": name, "passed": False, "message": f"{type(error).__name__}: {error}"}
                  for name in FAILURE_TEST_IDS]
        metrics = {}
    result = {"project": "rl-sim", "version": 1, "tests": checks, "metrics": metrics,
              "generated_at": datetime.now(timezone.utc).isoformat()}
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    passed = sum(row["passed"] for row in checks)
    print(f"{passed}/{len(checks)} checks passed")
    for row in checks:
        print(f"{'PASS' if row['passed'] else 'FAIL'} {row['id']}: {row['message']}")
    print(f"Metrics: {metrics}")
    print(f"Results written to {output}")
    return 0 if checks and passed == len(checks) else 1


if __name__ == "__main__":
    raise SystemExit(main())
