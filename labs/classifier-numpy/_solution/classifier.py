import numpy as np


def make_data(classes=2, seed=17):
    if classes not in (2, 3):
        raise ValueError("classes must be 2 or 3")
    rng = np.random.default_rng(seed)
    centers = np.array([[-2, -1], [2, -1], [0, 2.5]])[:classes]
    X = np.concatenate([rng.normal(center, 0.8, (200, 2)) for center in centers])
    y = np.repeat(np.arange(classes), 200)
    order = rng.permutation(len(y))
    split = int(0.8 * len(y))
    train, val = order[:split], order[split:]
    return X[train], y[train], X[val], y[val]


def sigmoid(z):
    """Return one probability per score, preserving shape."""
    return np.exp(-np.logaddexp(0, -z))


def softmax(z):
    """Return row probabilities for logits of shape (n, k)."""
    shifted = z - np.max(z, axis=1, keepdims=True)
    exps = np.exp(shifted)
    return exps / np.sum(exps, axis=1, keepdims=True)


def binary_loss_grad(X, y, w, b):
    """Return mean cross-entropy, dw (d,), db scalar from binary logits."""
    z = X @ w + b
    loss = np.mean(np.logaddexp(0, z) - y * z)
    residual = sigmoid(z) - y
    return float(loss), X.T @ residual / len(y), float(np.mean(residual))


def multiclass_loss_grad(X, y, w, b):
    """Return mean cross-entropy, dw (d,k), db (k,) for integer labels."""
    z = X @ w + b
    shifted = z - np.max(z, axis=1, keepdims=True)
    loss = np.mean(np.log(np.sum(np.exp(shifted), axis=1)) - shifted[np.arange(len(y)), y])
    residual = softmax(z).copy()
    residual[np.arange(len(y)), y] -= 1
    return float(loss), X.T @ residual / len(y), np.mean(residual, axis=0)


def train(X, y, classes=2, lr=0.1, steps=600):
    """Return w, b, history with initial loss and one loss per update."""
    shape = (X.shape[1],) if classes == 2 else (X.shape[1], classes)
    w = np.zeros(shape)
    b = 0.0 if classes == 2 else np.zeros(classes)
    objective = binary_loss_grad if classes == 2 else multiclass_loss_grad
    history = [objective(X, y, w, b)[0]]
    for _ in range(steps):
        _, dw, db = objective(X, y, w, b)
        w -= lr * dw
        b -= lr * db
        history.append(objective(X, y, w, b)[0])
    return w, b, history


def confusion_matrix(y, predicted, classes):
    """Return integer counts with true labels in rows and predictions in columns."""
    matrix = np.zeros((classes, classes), dtype=int)
    np.add.at(matrix, (y, predicted), 1)
    return matrix


def metrics(matrix):
    """Return accuracy scalar, precision and recall arrays. Undefined ratios are zero."""
    tp = np.diag(matrix)
    predicted = matrix.sum(axis=0)
    actual = matrix.sum(axis=1)
    precision = np.divide(tp, predicted, out=np.zeros(len(tp)), where=predicted != 0)
    recall = np.divide(tp, actual, out=np.zeros(len(tp)), where=actual != 0)
    accuracy = float(tp.sum() / matrix.sum()) if matrix.sum() else 0.0
    return accuracy, precision, recall
