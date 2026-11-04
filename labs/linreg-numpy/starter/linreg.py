import numpy as np


def predict(X, w, b):
    raise NotImplementedError


def mse(y_hat, y):
    raise NotImplementedError


def gradients(X, y, w, b):
    raise NotImplementedError


def fit(X, y, lr, steps):
    raise NotImplementedError


def train_val_split(X, y, val_frac=0.2, seed=42):
    raise NotImplementedError


def finite_difference_gradients(X, y, w, b, eps=1e-6):
    raise NotImplementedError


def lr_experiment(X, y, rates=(0.1, 1.0), steps=250):
    return {rate: fit(X, y, rate, steps) for rate in rates}


def plot_history(history, output_dir):
    raise NotImplementedError
