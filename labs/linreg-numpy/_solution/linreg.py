import numpy as np


def predict(X, w, b):
    return X @ w + b


def mse(y_hat, y):
    return float(np.mean((y_hat - y) ** 2))


def gradients(X, y, w, b):
    error = predict(X, w, b) - y
    return (2 / len(y)) * X.T @ error, float(2 * np.mean(error))


def fit(X, y, lr, steps):
    w = np.zeros(X.shape[1])
    b = 0.0
    history = []
    for _ in range(steps):
        loss = mse(predict(X, w, b), y)
        history.append((loss, w.copy(), b))
        dw, db = gradients(X, y, w, b)
        w -= lr * dw
        b -= lr * db
    return w, b, history


def train_val_split(X, y, val_frac=0.2, seed=42):
    indices = np.random.default_rng(seed).permutation(len(y))
    split = int(len(y) * (1 - val_frac))
    return X[indices[:split]], X[indices[split:]], y[indices[:split]], y[indices[split:]]


def lr_experiment(X, y, rates=(0.1, 1.0), steps=250):
    return {rate: fit(X, y, rate, steps) for rate in rates}
