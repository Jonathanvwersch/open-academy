"""Starter code for the two-layer neural-network project."""

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


def init_params(n_in, n_hidden, n_out, seed=42):
    """Create W1, b1, W2, and b2 with one neuron per weight row."""
    raise NotImplementedError


def forward(params, X):
    """Return sigmoid predictions and a cache for the backward pass."""
    raise NotImplementedError


def loss(y_hat, y):
    """Return mean binary cross-entropy with probability clipping."""
    raise NotImplementedError


def backward(params, cache, y):
    """Return the mean-loss gradients for each parameter."""
    raise NotImplementedError


def numerical_grad(f, params, eps=1e-5):
    """Estimate each parameter derivative using central differences."""
    raise NotImplementedError


def train(params, X, y, lr=0.2, steps=4000):
    """Update params with full-batch gradient descent and return loss history."""
    raise NotImplementedError


def accuracy(y_hat, y):
    """Return the fraction of binary predictions classified correctly."""
    raise NotImplementedError
