import numpy as np


def make_data(classes=2, seed=17):
    if classes not in (2, 3):
        raise ValueError("classes must be 2 or 3")
    rng = np.random.default_rng(seed)
    centers = np.array([[-2, -1], [2, -1], [0, 2.5]])[:classes]
    spread = 1.6 if classes == 2 else 1.4
    X = np.concatenate([rng.normal(center, spread, (200, 2)) for center in centers])
    y = np.repeat(np.arange(classes), 200)
    order = rng.permutation(len(y))
    split = int(0.8 * len(y))
    train, val = order[:split], order[split:]
    return X[train], y[train], X[val], y[val]


def sigmoid(z):
    """Return one probability per score, preserving shape."""
    # TODO: Return one probability per score, preserving shape.
    raise NotImplementedError("sigmoid")


def softmax(z):
    """Return row probabilities for logits of shape (n, k)."""
    # TODO: Return row probabilities for logits of shape (n, k).
    raise NotImplementedError("softmax")


def binary_loss_grad(X, y, w, b):
    """Return mean cross-entropy, dw (d,), db scalar from binary logits."""
    # TODO: Return mean cross-entropy, dw (d,), db scalar from binary logits.
    raise NotImplementedError("binary_loss_grad")


def multiclass_loss_grad(X, y, w, b):
    """Return mean cross-entropy, dw (d,k), db (k,) for integer labels."""
    # TODO: Return mean cross-entropy, dw (d,k), db (k,) for integer labels.
    raise NotImplementedError("multiclass_loss_grad")


def train(X, y, classes=2, lr=0.1, steps=600):
    """Return w, b, history with initial loss and one loss per update."""
    # TODO: Return w, b, history with initial loss and one loss per update.
    raise NotImplementedError("train")


def confusion_matrix(y, predicted, classes):
    """Return integer counts with true labels in rows and predictions in columns."""
    # TODO: Return integer counts with true labels in rows and predictions in columns.
    raise NotImplementedError("confusion_matrix")


def metrics(matrix):
    """Return accuracy scalar, precision and recall arrays. Undefined ratios are zero."""
    # TODO: Return accuracy scalar, precision and recall arrays. Undefined ratios are zero.
    raise NotImplementedError("metrics")
