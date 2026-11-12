"""Deterministic public checks used by the local project verifier."""

import numpy as np


def _check(checks, check_id, passed, message):
    checks.append({"id": check_id, "passed": bool(passed), "message": message})


def _sigmoid(z):
    return 1 / (1 + np.exp(-np.clip(z, -40, 40)))


def _linear_baseline(X, y, X_eval, steps=5000, lr=0.2):
    W = np.zeros((1, X.shape[1]))
    b = np.zeros(1)
    for _ in range(steps):
        y_hat = _sigmoid(X @ W.T + b)
        dZ = y_hat - y
        W -= lr * (dZ.T @ X) / len(y)
        b -= lr * np.mean(dZ, axis=0)
    return _sigmoid(X_eval @ W.T + b)


def run_checks(model):
    checks = []
    X_train, y_train, X_val, y_val = model.make_data()
    X_repeat, y_repeat, X_val_repeat, y_val_repeat = model.make_data()
    deterministic = all(
        np.array_equal(first, second)
        for first, second in (
            (X_train, X_repeat),
            (y_train, y_repeat),
            (X_val, X_val_repeat),
            (y_val, y_val_repeat),
        )
    )
    _check(
        checks,
        "test_data_is_seeded_and_split",
        deterministic
        and X_train.shape == (480, 2)
        and y_train.shape == (480, 1)
        and X_val.shape == (120, 2)
        and y_val.shape == (120, 1),
        "The fixed-seed helper should return repeatable 480/120 train-validation splits.",
    )

    X_small = np.array([[-0.7, 0.2], [0.3, 1.1], [1.2, -0.8], [-1.1, -0.4]])
    y_small = np.array([[0.0], [1.0], [1.0], [0.0]])
    params = model.init_params(2, 5, 1, seed=23)
    y_hat, cache = model.forward(params, X_small)
    gradients = model.backward(params, cache, y_small)
    expected_shapes = {
        "W1": (5, 2),
        "b1": (5,),
        "W2": (1, 5),
        "b2": (1,),
    }
    shape_ok = (
        set(params) == set(expected_shapes)
        and set(gradients) == set(expected_shapes)
        and all(params[key].shape == shape for key, shape in expected_shapes.items())
        and all(gradients[key].shape == shape for key, shape in expected_shapes.items())
        and y_hat.shape == (4, 1)
        and cache["H"].shape == (4, 5)
    )
    _check(
        checks,
        "test_parameter_forward_and_gradient_shapes",
        shape_ok,
        "Parameters and gradients must have matching layer shapes; predictions are (batch, 1).",
    )

    reference_params = {
        "W1": np.array([[1.0, 0.0], [0.0, 1.0]]),
        "b1": np.array([0.0, 0.0]),
        "W2": np.array([[2.0, -1.0]]),
        "b2": np.array([0.0]),
    }
    reference_X = np.array([[1.0, 2.0], [-1.0, 0.5], [0.5, -1.0]])
    expected_prediction = np.array([[0.5], [0.3775406688], [0.7310585786]])
    actual_prediction, _ = model.forward(reference_params, reference_X)
    forward_ok = np.allclose(actual_prediction, expected_prediction, atol=1e-9)
    _check(
        checks,
        "test_forward_matches_reference",
        forward_ok,
        "The fixed three-example input should produce the reference sigmoid predictions.",
    )

    loss_predictions = np.array([[0.25], [0.75], [0.9]])
    loss_targets = np.array([[0.0], [1.0], [1.0]])
    expected_loss = -(np.log(0.75) + np.log(0.75) + np.log(0.9)) / 3
    actual_loss = model.loss(loss_predictions, loss_targets)
    loss_ok = np.isclose(actual_loss, expected_loss, atol=1e-12)
    clipped_loss = model.loss(np.array([[0.0], [1.0]]), np.array([[1.0], [0.0]]))
    loss_ok = loss_ok and np.isfinite(clipped_loss)
    _check(
        checks,
        "test_loss_matches_mean_binary_cross_entropy",
        loss_ok,
        "Loss should be mean binary cross-entropy and remain finite at probabilities 0 and 1.",
    )

    def objective(candidate):
        prediction, _ = model.forward(candidate, X_small)
        return model.loss(prediction, y_small)

    analytic = model.backward(params, cache, y_small)
    numeric = model.numerical_grad(objective, params, eps=1e-5)
    relative_errors = []
    for name in params:
        denominator = np.maximum(
            np.abs(analytic[name]) + np.abs(numeric[name]), 1e-8
        )
        relative_errors.extend(
            (np.abs(analytic[name] - numeric[name]) / denominator).ravel().tolist()
        )
    max_gradient_error = float(max(relative_errors, default=0.0))
    _check(
        checks,
        "test_gradients_match_numerical_differences",
        max_gradient_error < 1e-5,
        f"Maximum elementwise relative error is {max_gradient_error:.3g}; it must be below 1e-5.",
    )

    one_step_params = model.init_params(2, 5, 1, seed=9)
    one_step_history = model.train(
        one_step_params, X_small, y_small, lr=0.05, steps=1
    )
    one_step_ok = (
        len(one_step_history) == 2 and one_step_history[-1] < one_step_history[0]
    )
    _check(
        checks,
        "test_training_step_lowers_loss",
        one_step_ok,
        "One full-batch gradient-descent update should lower the fixed batch loss.",
    )

    trained_params = model.init_params(2, 32, 1, seed=7)
    history = model.train(trained_params, X_train, y_train, lr=0.2, steps=4000)
    final_train_loss = float(history[-1])
    validation_prediction, _ = model.forward(trained_params, X_val)
    validation_accuracy = float(model.accuracy(validation_prediction, y_val))
    _check(
        checks,
        "test_training_reaches_validation_accuracy",
        validation_accuracy >= 0.9 and final_train_loss < 0.1,
        (
            f"Validation accuracy is {validation_accuracy:.3f} and final train loss is "
            f"{final_train_loss:.4f}; require accuracy >= 0.9 and loss < 0.1."
        ),
    )

    baseline_prediction = _linear_baseline(X_train, y_train, X_val)
    baseline_accuracy = float(model.accuracy(baseline_prediction, y_val))
    baseline_gap = validation_accuracy - baseline_accuracy
    _check(
        checks,
        "test_hidden_layer_beats_linear_baseline",
        baseline_gap >= 0.1,
        (
            f"MLP accuracy is {validation_accuracy:.3f}; linear baseline accuracy is "
            f"{baseline_accuracy:.3f}; require a gap of at least 0.10."
        ),
    )

    metrics = {
        "final_train_loss": final_train_loss,
        "validation_accuracy": validation_accuracy,
        "max_gradient_check_relative_error": max_gradient_error,
    }
    return checks, metrics
