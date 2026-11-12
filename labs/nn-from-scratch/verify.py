import argparse
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load Python module from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser(description="Verify the nn-from-scratch project.")
    parser.add_argument(
        "--implementation",
        type=Path,
        default=ROOT / "work" / "nn.py",
        help="Python file containing the learner's implementation.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "work" / "results.json",
        help="Path for the JSON results file.",
    )
    args = parser.parse_args()
    implementation = args.implementation.resolve()
    output = args.output.resolve()
    checks = []
    metrics = {}

    try:
        model = load_module(implementation, "nn_from_scratch_candidate")
        suite = load_module(ROOT / "tests" / "checks.py", "nn_from_scratch_checks")
        checks, metrics = suite.run_checks(model)
    except Exception as error:
        checks = [
            {
                "id": "test_verifier_completed",
                "passed": False,
                "message": f"{type(error).__name__}: {error}",
            }
        ]

    result = {
        "project": "nn-from-scratch",
        "version": 1,
        "tests": checks,
        "metrics": metrics,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")

    passed = sum(check["passed"] for check in checks)
    print(f"{passed}/{len(checks)} checks passed")
    for check in checks:
        state = "PASS" if check["passed"] else "FAIL"
        print(f"{state} {check['id']}: {check['message']}")
    if metrics:
        print("Metrics:")
        for name, value in metrics.items():
            print(f"  {name}: {value:.8g}")
    print(f"Results written to {output}")
    return 0 if passed == len(checks) and checks else 1


if __name__ == "__main__":
    raise SystemExit(main())
