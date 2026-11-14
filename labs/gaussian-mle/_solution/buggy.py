"""A common mistake: dropping the front factor of the normal density.

The maximum-likelihood lesson drops ln(1/(sigma*sqrt(2*pi))) because it is the same
for every mu. That is only safe while sigma is fixed. This version also drops it
when fitting sigma, so wider bells always look better.
"""

import importlib.util
from pathlib import Path

import numpy as np

_spec = importlib.util.spec_from_file_location(
    "gaussian_reference", Path(__file__).with_name("gaussian.py")
)
_reference = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_reference)


def log_density(x, mu, sigma):
    x = np.asarray(x, dtype=float)
    return -((x - mu) ** 2) / (2 * sigma**2)


def log_likelihood(x, mu, sigma):
    return float(np.sum(log_density(x, mu, sigma)))


def best_sigma(x, mu, sigmas):
    scores = [log_likelihood(x, mu, sigma) for sigma in sigmas]
    return float(sigmas[int(np.argmax(scores))])


def average_log_likelihood(x, mu, sigma):
    return log_likelihood(x, mu, sigma) / len(x)


def bell_forecast(bins, mu, sigma):
    heights = np.exp(log_density(bins, mu, sigma))
    return heights / np.sum(heights)


def __getattr__(name):
    return getattr(_reference, name)
