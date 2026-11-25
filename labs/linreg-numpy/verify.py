import argparse
import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import yaml


ROOT = Path(__file__).parent
TRUE_W = np.array([1.5, -2.0])
TRUE_B = 0.7
FAILURE_TEST_IDS = (
    "test_predict_shape_and_values",
    "test_mse_is_mean",
    "test_gradients_match_finite_differences",
    "test_fit_decreases_loss",
    "test_split_is_disjoint_and_seeded",
    "test_lr_0_1_converges",
    "test_lr_1_diverges",
    "test_recovers_true_weights",
)


def data():
    rng = np.random.default_rng(2026)
    x = rng.multivariate_normal([0, 0], [[1, 0.5], [0.5, 1]], size=1200)
    y = x @ TRUE_W + TRUE_B + rng.normal(0, 0.5, size=len(x))
    return x, y


def load(path):
    spec = importlib.util.spec_from_file_location("learner_linreg", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def valid_split(x, y, train_x, val_x, train_y, val_y, repeated):
    if not (len(train_x) > 0 and len(val_x) > 0 and len(train_x) + len(val_x) == len(x)):
        return False
    if not all(np.array_equal(actual, again) for actual, again in zip(
        (train_x, val_x, train_y, val_y), repeated
    )):
        return False
    # Each generated feature row is unique. Check the full examples, including targets,
    # so duplicates, dropped examples, overlap and shuffled labels all fail.
    original = np.column_stack((x, y))
    combined = np.concatenate((np.column_stack((train_x, train_y)), np.column_stack((val_x, val_y))))
    order = np.lexsort(original.T)
    combined_order = np.lexsort(combined.T)
    return np.array_equal(original[order], combined[combined_order])


def run(path, output):
    model = load(path)
    project = yaml.safe_load((ROOT / "project.yaml").read_text())
    thresholds = {metric["id"]: metric for metric in project["metrics"]}
    val_mse_limit = thresholds["val_mse"]["threshold"]
    weight_error_limit = thresholds["weight_error"]["threshold"]
    x, y = data()
    train_x, val_x, train_y, val_y = model.train_val_split(x, y, 0.2, 91)
    w, b, history = model.fit(train_x, train_y, 0.1, 500)
    eps = 1e-6
    dw, db = model.gradients(train_x[:16], train_y[:16], np.zeros(2), 0.0)
    numeric = []
    for axis in range(2):
        step = np.eye(2)[axis] * eps
        numeric.append(
            (model.mse(model.predict(train_x[:16], step, 0), train_y[:16])
             - model.mse(model.predict(train_x[:16], -step, 0), train_y[:16])) / (2 * eps)
        )
    checks = []
    def check(check_id, condition, message):
        checks.append({"id": check_id, "passed": bool(condition), "message": message})

    check("test_predict_shape_and_values", np.allclose(model.predict(x[:3], TRUE_W, TRUE_B), x[:3] @ TRUE_W + TRUE_B), "Vectorised predictions")
    check("test_mse_is_mean", abs(model.mse(np.array([0., 2.]), np.array([0., 0.])) - 2) < 1e-9, "MSE is averaged")
    check("test_gradients_match_finite_differences", np.allclose(dw, numeric, rtol=1e-5, atol=1e-7) and abs(db - np.mean((model.predict(train_x[:16], np.zeros(2), 0) - train_y[:16])) * 2) < 1e-5, "Analytic gradients match finite differences")
    check("test_fit_decreases_loss", len(history) > 1 and history[-1][0] < history[0][0], "Gradient descent decreases loss")
    check("test_split_is_disjoint_and_seeded", valid_split(x, y, train_x, val_x, train_y, val_y, model.train_val_split(x, y, .2, 91)), "Split is seeded and disjoint, preserving every example and target")
    val_mse = model.mse(model.predict(val_x, w, b), val_y)
    weight_error = float(np.max(np.abs(w - TRUE_W)))
    check(
        "test_recovers_true_weights",
        val_mse < val_mse_limit and weight_error < weight_error_limit,
        "Held-out metrics meet project criteria",
    )
    experiments = model.lr_experiment(train_x, train_y, (0.1, 1.0), 150)
    check("test_lr_0_1_converges", experiments[0.1][2][-1][0] < experiments[0.1][2][0][0], "lr=0.1 converges")
    check("test_lr_1_diverges", experiments[1.0][2][-1][0] > experiments[1.0][2][0][0], "lr=1.0 diverges")
    result = {
        "project": "linreg-numpy",
        "version": 1,
        "tests": checks,
        "metrics": {"val_mse": float(val_mse), "weight_error": weight_error},
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    output.write_text(json.dumps(result, indent=2) + "\n")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--implementation", type=Path, default=ROOT / "work/linreg.py")
    parser.add_argument("--output", type=Path, default=ROOT / "work/results.json")
    args = parser.parse_args()
    try:
        result = run(args.implementation, args.output)
        passed = sum(item["passed"] for item in result["tests"])
        print(f"{passed}/{len(result['tests'])} checks passed; val_mse={result['metrics']['val_mse']:.4f}; weight_error={result['metrics']['weight_error']:.4f}")
        if passed != len(result["tests"]):
            raise SystemExit(1)
    except Exception as error:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        message = f"{type(error).__name__}: {error}"
        tests = [{"id": test_id, "passed": False, "message": message} for test_id in FAILURE_TEST_IDS]
        args.output.write_text(json.dumps({"project": "linreg-numpy", "version": 1, "tests": tests, "metrics": {}, "generated_at": datetime.now(timezone.utc).isoformat()}, indent=2) + "\n")
        raise
