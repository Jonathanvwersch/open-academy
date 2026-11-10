"""Reference implementation for the two-layer neural-network project."""

import numpy as np


def make_data(n_samples=600, validation_fraction=0.2, seed=42, noise=0.08):
    """Return seeded two-moons train and validation arrays."""
    rng = np.random.default_rng(seed)
    n_first = n_samples // 2
    n_second = n_samples - n_first
    first_angle = rng.random(n_first) * np.pi
    second_angle = rng.random(n_second) * np.pi

    first_moon = np.column_stack((np.cos(first_angle), np.sin(first_angle)))
    second_moon = np.column_stack(
        (1 - np.cos(second_angle), 0.5 - np.sin(second_angle))
    )
    X = np.vstack((first_moon, second_moon))
    X += rng.normal(0, noise, X.shape)
    y = np.vstack((np.zeros((n_first, 1)), np.ones((n_second, 1))))

    order = rng.permutation(n_samples)
    X, y = X[order], y[order]
    split = int(n_samples * (1 - validation_fraction))
    return X[:split], y[:split], X[split:], y[split:]


def _sigmoid(z):
    result = np.empty_like(z, dtype=float)
    positive = z >= 0
    result[positive] = 1 / (1 + np.exp(-z[positive]))
    exp_z = np.exp(z[~positive])
    result[~positive] = exp_z / (1 + exp_z)
    return result


def init_params(n_in, n_hidden, n_out, seed=42):
    rng = np.random.default_rng(seed)
    return {
        "W1": rng.normal(0, np.sqrt(2 / n_in), (n_hidden, n_in)),
        "b1": np.zeros(n_hidden),
        "W2": rng.normal(0, np.sqrt(1 / n_hidden), (n_out, n_hidden)),
        "b2": np.zeros(n_out),
    }


def forward(params, X):
    Z1 = X @ params["W1"].T + params["b1"]
    H = np.maximum(Z1, 0)
    Z2 = H @ params["W2"].T + params["b2"]
    y_hat = _sigmoid(Z2)
    cache = {"X": X, "Z1": Z1, "H": H, "Z2": Z2, "y_hat": y_hat}
    return y_hat, cache


def loss(y_hat, y):
    clipped = np.clip(y_hat, 1e-7, 1 - 1e-7)
    return float(-np.mean(y * np.log(clipped) + (1 - y) * np.log(1 - clipped)))


def backward(params, cache, y):
    n_examples = y.shape[0]
    dZ2 = (cache["y_hat"] - y) / n_examples
    dW2 = dZ2.T @ cache["H"]
    db2 = np.sum(dZ2, axis=0)
    dH = dZ2 @ params["W2"]
    dZ1 = dH * (cache["Z1"] > 0)
    dW1 = dZ1.T @ cache["X"]
    db1 = np.sum(dZ1, axis=0)
    return {"W1": dW1, "b1": db1, "W2": dW2, "b2": db2}


def numerical_grad(f, params, eps=1e-5):
    gradients = {}
    for name, value in params.items():
        gradient = np.zeros_like(value, dtype=float)
        for index in np.ndindex(value.shape):
            plus = {key: array.copy() for key, array in params.items()}
            minus = {key: array.copy() for key, array in params.items()}
            plus[name][index] += eps
            minus[name][index] -= eps
            gradient[index] = (f(plus) - f(minus)) / (2 * eps)
        gradients[name] = gradient
    return gradients


def train(params, X, y, lr=0.2, steps=4000):
    history = []
    for _ in range(steps):
        y_hat, cache = forward(params, X)
        history.append(loss(y_hat, y))
        gradients = backward(params, cache, y)
        for name in params:
            params[name] -= lr * gradients[name]

    y_hat, _ = forward(params, X)
    history.append(loss(y_hat, y))
    return history


def accuracy(y_hat, y):
    return float(np.mean((y_hat >= 0.5) == (y >= 0.5)))
