import argparse
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parent
FAILURE_TEST_IDS = (
    "test_centre",
    "test_covariance",
    "test_eigen_sorted",
    "test_svd_sign_invariant",
    "test_projection",
    "test_reconstruction",
    "test_error",
    "test_explained_variance",
    "test_image_compression",
)


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load Python module from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser(description="Verify the pca-numpy project.")
    parser.add_argument(
        "--implementation",
        type=Path,
        default=ROOT / "work" / "pca.py",
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
        model = load_module(implementation, "pca_numpy_candidate")
        suite = load_module(ROOT / "tests" / "checks.py", "pca_numpy_checks")
        checks, metrics = suite.run_checks(model, load_module(ROOT / "data.py", "pca_data").make_images)
    except Exception as error:
        message = f"{type(error).__name__}: {error}"
        checks = [{"id": test_id, "passed": False, "message": message} for test_id in FAILURE_TEST_IDS]

    result = {
        "project": "pca-numpy",
        "version": 1,
        "tests": checks,
        "metrics": metrics,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n", encoding="utf-8")

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
