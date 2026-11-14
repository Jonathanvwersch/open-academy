"""Print your fit and the comparisons the reflection questions ask about.

Run it from anywhere with: python3 labs/gaussian-mle/work/report.py
"""

from pathlib import Path
import importlib.util

import numpy as np

_spec = importlib.util.spec_from_file_location(
    "gaussian_work", Path(__file__).with_name("gaussian.py")
)
g = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(g)


def main():
    train, held_out = g.make_readings()
    mu, sigma = g.fit_gaussian(train)
    print(f"Training readings: {len(train)}, held-out readings: {len(held_out)}")
    print(f"Fitted mean {mu:.3f} cm, standard deviation {sigma:.3f} cm")
    print(f"Sample standard deviation (n - 1): {g.std(train, sample=True):.3f} cm")

    sigmas = np.round(np.arange(0.5, 6.0001, 0.01), 2)
    print(f"Best sigma on the grid: {g.best_sigma(train, mu, sigmas):.2f} cm")

    fits = {
        "fitted bell": (mu, sigma),
        "centre 2 cm too high": (mu + 2, sigma),
        "twice as wide": (mu, 2 * sigma),
        "half as wide": (mu, sigma / 2),
    }
    print("\nAverage log-likelihood per reading:")
    print(f"  {'fit':<22}{'training':>10}{'held-out':>10}")
    for name, (m, s) in fits.items():
        train_score = g.average_log_likelihood(train, m, s)
        held_score = g.average_log_likelihood(held_out, m, s)
        print(f"  {name:<22}{train_score:>10.3f}{held_score:>10.3f}")

    bins = np.arange(90, 111)
    p = g.bin_fractions(held_out, bins)
    print(f"\nEntropy of the held-out bins: {g.entropy(p):.3f} bits")
    print("Cross-entropy of each bell as a forecast of those bins:")
    for name, (m, s) in fits.items():
        print(f"  {name:<22}{g.cross_entropy(p, g.bell_forecast(bins, m, s)):>10.3f} bits")


if __name__ == "__main__":
    main()
