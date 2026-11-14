import argparse
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import sys

import torch


ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser(description="Verify the CPU image classifier.")
    parser.add_argument("--implementation", type=Path, default=ROOT / "work/classifier.py")
    parser.add_argument("--output", type=Path, default=ROOT / "work/results.json")
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()
    torch.set_num_threads(1)
    torch.use_deterministic_algorithms(True)
    suite = load(ROOT / "tests/checks.py", "image_checks")
    try:
        candidate = load(args.implementation.resolve(), "image_candidate")
        checks, metrics, records = suite.run(candidate, args.seed)
    except Exception as error:
        checks = [dict(id=name, passed=False, message=f"{type(error).__name__}: {error}")
                  for name in suite.IDS]
        metrics, records = {}, []
    result = dict(project="image-classifier", version=1, tests=checks, metrics=metrics,
                  generated_at=datetime.now(timezone.utc).isoformat())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    if records:
        args.output.with_name("history.json").write_text(json.dumps(records, indent=2) + "\n")
    print(f"{sum(c['passed'] for c in checks)}/{len(checks)} checks passed")
    for check in checks:
        print(f"{'PASS' if check['passed'] else 'FAIL'} {check['id']}: {check['message']}")
    print(f"Metrics: {json.dumps(metrics, sort_keys=True)}")
    print(f"Results written to {args.output}")
    return 0 if all(c["passed"] for c in checks) else 1


if __name__ == "__main__":
    raise SystemExit(main())
