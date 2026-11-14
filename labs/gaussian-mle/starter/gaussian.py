"""Starter code for the Gaussian maximum-likelihood project.

Fill in every function marked TODO. The two helpers at the top are done for you.
"""

import numpy as np


def make_readings(n_train=200, n_held_out=200, seed=22):
    """Return seeded training and held-out sensor readings in whole centimetres.

    The sensor is aimed at a wall 100 cm away and its noise has standard
    deviation 2 cm. Fit on the training readings only.
    """
    rng = np.random.default_rng(seed)
    readings = np.round(rng.normal(100.0, 2.0, n_train + n_held_out))
    return readings[:n_train], readings[n_train:]


def bin_fractions(readings, bins):
    """Return the fraction of readings equal to each whole-centimetre bin."""
    readings = np.asarray(readings)
    return np.array([np.mean(readings == value) for value in bins])


def mean(x):
    """Return the mean of the readings x."""
    # TODO: add the readings and divide by how many there are.
    raise NotImplementedError


def variance(x, sample=False):
    """Return the variance of x.

    With sample=False, average the squared deviations from the mean (divide by n).
    With sample=True, divide by n - 1 instead.
    """
    # TODO: square each reading's deviation from the mean, add them, then divide.
    raise NotImplementedError


def std(x, sample=False):
    """Return the standard deviation of x, the square root of its variance."""
    # TODO
    raise NotImplementedError


def log_density(x, mu, sigma):
    """Return ln f(x) for the Gaussian with mean mu and standard deviation sigma.

    x can be a single number or an array. Return one log height per reading.
    """
    # TODO: take ln of the normal density and simplify before computing.
    raise NotImplementedError


def log_likelihood(x, mu, sigma):
    """Return the log-likelihood of the guess (mu, sigma) for all readings x."""
    # TODO: the readings are independent. Use log_density.
    raise NotImplementedError


def fit_gaussian(x):
    """Return the maximum-likelihood guess (mu, sigma) for the readings x."""
    # TODO
    raise NotImplementedError


def best_sigma(x, mu, sigmas):
    """Return the value in sigmas with the highest log-likelihood for x, with mu fixed."""
    # TODO
    raise NotImplementedError


def average_log_likelihood(x, mu, sigma):
    """Return the log-likelihood per reading, so data sets of any size compare fairly."""
    # TODO
    raise NotImplementedError


def entropy(p):
    """Return the entropy H(p) of the discrete distribution p, in bits."""
    # TODO: outcomes with probability 0 add nothing.
    raise NotImplementedError


def cross_entropy(p, q):
    """Return the cross-entropy H(p, q) in bits: actual p, forecast q.

    Return float("inf") when q gives probability 0 to an outcome that p says can happen.
    """
    # TODO
    raise NotImplementedError


def bell_forecast(bins, mu, sigma):
    """Return a forecast probability for each whole-centimetre bin from the bell (mu, sigma).

    The returned probabilities must add up to 1.
    """
    # TODO: use the bell's height at each bin.
    raise NotImplementedError
