"""Reference implementation for the Gaussian maximum-likelihood project."""

import numpy as np


def make_readings(n_train=200, n_held_out=200, seed=22):
    """Return seeded training and held-out sensor readings in whole centimetres."""
    rng = np.random.default_rng(seed)
    readings = np.round(rng.normal(100.0, 2.0, n_train + n_held_out))
    return readings[:n_train], readings[n_train:]


def bin_fractions(readings, bins):
    """Return the fraction of readings equal to each whole-centimetre bin."""
    readings = np.asarray(readings)
    return np.array([np.mean(readings == value) for value in bins])


def mean(x):
    x = np.asarray(x, dtype=float)
    return float(np.sum(x) / len(x))


def variance(x, sample=False):
    x = np.asarray(x, dtype=float)
    divisor = len(x) - 1 if sample else len(x)
    return float(np.sum((x - mean(x)) ** 2) / divisor)


def std(x, sample=False):
    return float(np.sqrt(variance(x, sample)))


def log_density(x, mu, sigma):
    x = np.asarray(x, dtype=float)
    return -np.log(sigma * np.sqrt(2 * np.pi)) - (x - mu) ** 2 / (2 * sigma**2)


def log_likelihood(x, mu, sigma):
    return float(np.sum(log_density(x, mu, sigma)))


def fit_gaussian(x):
    return mean(x), std(x)


def best_sigma(x, mu, sigmas):
    scores = [log_likelihood(x, mu, sigma) for sigma in sigmas]
    return float(sigmas[int(np.argmax(scores))])


def average_log_likelihood(x, mu, sigma):
    return log_likelihood(x, mu, sigma) / len(x)


def entropy(p):
    p = np.asarray(p, dtype=float)
    seen = p > 0
    return float(np.sum(p[seen] * np.log2(1 / p[seen])))


def cross_entropy(p, q):
    p = np.asarray(p, dtype=float)
    q = np.asarray(q, dtype=float)
    seen = p > 0
    if np.any(q[seen] == 0):
        return float("inf")
    return float(np.sum(p[seen] * np.log2(1 / q[seen])))


def bell_forecast(bins, mu, sigma):
    heights = np.exp(log_density(bins, mu, sigma))
    return heights / np.sum(heights)
