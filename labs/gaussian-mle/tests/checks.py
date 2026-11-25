"""Deterministic public checks used by the local gaussian-mle verifier."""

from pathlib import Path

import numpy as np
import yaml


PROJECT_FILE = Path(__file__).resolve().parents[1] / "project.yaml"
TRUE_MU = 100.0
TRUE_SIGMA = 2.0
SIGMA_GRID = np.round(np.arange(0.5, 6.0001, 0.01), 2)
BINS = np.arange(90, 111)


def _log_density(x, mu, sigma):
    x = np.asarray(x, dtype=float)
    return -np.log(sigma * np.sqrt(2 * np.pi)) - (x - mu) ** 2 / (2 * sigma**2)


def _close(actual, expected, tol=1e-6):
    try:
        actual = np.asarray(actual, dtype=float)
    except (TypeError, ValueError):
        return False
    return actual.shape == np.shape(expected) and bool(
        np.allclose(actual, expected, rtol=tol, atol=tol)
    )


def _fmt(values):
    return np.array2string(np.asarray(values, dtype=float), precision=4, separator=", ")


def check_mean_variance_std(model, data):
    x = np.array([97.0, 99.0, 100.0, 101.0, 103.0])
    got = {
        "mean": model.mean(x),
        "variance": model.variance(x),
        "std": model.std(x),
        "sample variance": model.variance(x, sample=True),
        "sample std": model.std(x, sample=True),
    }
    expected = {
        "mean": 100.0,
        "variance": 4.0,
        "std": 2.0,
        "sample variance": 5.0,
        "sample std": np.sqrt(5.0),
    }
    wrong = [name for name in expected if not _close(got[name], expected[name])]
    if not wrong:
        return True, "Mean 100, variance 4 and standard deviation 2 for readings 97, 99, 100, 101, 103."
    if _close(got["variance"], 5.0):
        return False, (
            "variance(x) returned 5, which divides by n - 1. With sample=False it should "
            "average the squared deviations over all n readings and give 4."
        )
    if _close(got["sample variance"], 4.0):
        return False, "variance(x, sample=True) returned 4. With sample=True, divide by n - 1 to get 5."
    parts = ", ".join(f"{name} {float(got[name]):.4g} (expected {expected[name]:.4g})" for name in wrong)
    return False, f"For readings 97, 99, 100, 101, 103: {parts}."


def check_log_density(model, data):
    x = np.array([100.0, 102.0, 96.0])
    expected = _log_density(x, 100.0, 2.0)
    got = model.log_density(x, 100.0, 2.0)
    narrow_expected = float(_log_density(100.0, 100.0, 0.5))
    narrow = model.log_density(100.0, 100.0, 0.5)
    if _close(got, expected) and _close(narrow, narrow_expected):
        return True, "Log heights match ln f(x) for the normal density, including the front factor."
    if _close(got, expected + np.log(2.0 * np.sqrt(2 * np.pi))):
        return False, (
            f"Got {_fmt(got)} for x = 100, 102, 96 with mu 100 and sigma 2; expected {_fmt(expected)}. "
            "The front factor 1/(sigma*sqrt(2*pi)) is missing. It is the same for every mu, "
            "but it changes with sigma, so keep -ln(sigma*sqrt(2*pi)) in every log height."
        )
    if _close(got, np.exp(expected)):
        return False, "log_density returned the height f(x) itself. Return its natural log, ln f(x)."
    return False, (
        f"Got {_fmt(got)} for x = 100, 102, 96 with mu 100 and sigma 2; expected {_fmt(expected)}, "
        "one log height per reading. Check the squared distance over 2*sigma**2."
    )


def check_log_likelihood(model, data):
    small = np.array([98.0, 101.0, 104.0])
    expected_small = float(np.sum(model.log_density(small, 101.0, 2.0)))
    got_small = model.log_likelihood(small, 101.0, 2.0)
    many = np.random.default_rng(5).normal(100.0, 2.0, 5000)
    expected_many = float(np.sum(model.log_density(many, 100.0, 2.0)))
    got_many = model.log_likelihood(many, 100.0, 2.0)
    if not np.isfinite(got_many):
        return False, (
            f"log_likelihood gave {got_many} for 5000 readings. The product of 5000 heights "
            "rounds to 0, so its log is minus infinity. Add the log heights instead."
        )
    if _close(got_small, expected_small) and _close(got_many, expected_many):
        return True, "Log-likelihood is the sum of the log heights and stays finite for 5000 readings."
    return False, (
        f"For readings 98, 101, 104 with mu 101 and sigma 2, got {float(got_small):.4f}; the sum "
        f"of your log_density values is {expected_small:.4f}."
    )


def check_fit_uses_mean_and_spread(model, data):
    train, _ = data
    mu, sigma = model.fit_gaussian(train)
    expected_mu = float(np.mean(train))
    expected_sigma = float(np.std(train))
    if _close(mu, expected_mu) and _close(sigma, expected_sigma):
        return True, f"Fit gives mu {mu:.3f} cm and sigma {sigma:.3f} cm on the training readings."
    if _close(mu, expected_mu) and _close(sigma, float(np.std(train, ddof=1))):
        return False, (
            f"Your sigma {sigma:.4f} divides by n - 1. The maximum-likelihood spread divides by n "
            f"and gives {expected_sigma:.4f}. best_sigma will show you why."
        )
    return False, (
        f"fit_gaussian gave ({float(mu):.4f}, {float(sigma):.4f}); expected the mean "
        f"{expected_mu:.4f} and the divide-by-n standard deviation {expected_sigma:.4f} of the training readings."
    )


def check_sigma_search(model, data):
    train, _ = data
    mu = float(np.mean(train))
    sigma = float(np.std(train))
    best = float(model.best_sigma(train, mu, SIGMA_GRID))
    if best >= SIGMA_GRID[-1] - 1e-9:
        return False, (
            f"The best sigma was {best:.2f} cm, the largest value tried. The log-likelihood should "
            "fall again for very wide bells. Check that each log height includes -ln(sigma*sqrt(2*pi))."
        )
    if abs(best - sigma) <= 0.011:
        return True, f"The grid search peaks at sigma {best:.2f} cm, matching the divide-by-n spread {sigma:.3f} cm."
    return False, (
        f"The grid search returned sigma {best:.2f} cm, but the divide-by-n spread of the training "
        f"readings is {sigma:.3f} cm. Return the grid value whose log-likelihood is highest."
    )


def _fits(train):
    mu = float(np.mean(train))
    sigma = float(np.std(train))
    return {
        "fitted bell": (mu, sigma),
        "centre 2 cm too high": (mu + 2, sigma),
        "twice as wide": (mu, 2 * sigma),
        "half as wide": (mu, sigma / 2),
    }


def check_held_out_comparison(model, data):
    train, held_out = data
    fits = _fits(train)
    scores = {name: float(model.average_log_likelihood(held_out, *fit)) for name, fit in fits.items()}
    expected = float(model.log_likelihood(held_out, *fits["fitted bell"])) / len(held_out)
    summary = "; ".join(f"{name} {score:.3f}" for name, score in scores.items())
    if not _close(scores["fitted bell"], expected):
        return False, (
            f"Average log-likelihood of the fitted bell on held-out readings is {scores['fitted bell']:.4f}; "
            f"your log_likelihood divided by {len(held_out)} readings gives {expected:.4f}. "
            "Divide the log-likelihood by the number of readings."
        )
    best = max(scores, key=scores.get)
    if best != "fitted bell":
        return False, (
            f"On held-out readings, the bell '{best}' scored highest ({summary}). The fitted bell should win. "
            "If a wider bell wins, the front factor is probably missing from log_density."
        )
    return True, f"Held-out average log-likelihood per reading: {summary}."


def check_entropy(model, data):
    cases = [([0.5, 0.25, 0.25], 1.5), ([0.25] * 4, 2.0), ([1.0, 0.0, 0.0, 0.0], 0.0)]
    got = [model.entropy(np.array(p)) for p, _ in cases]
    if all(_close(value, expected) for value, (_, expected) in zip(got, cases)):
        return True, "Entropy is 1.5, 2 and 0 bits for the three test distributions."
    if _close(got[0], 1.5 * np.log(2)):
        return False, "H(1/2, 1/4, 1/4) came out as 1.04. That uses the natural log. Use log base 2 to get bits."
    if not np.isfinite(got[2]):
        return False, (
            "Entropy of (1, 0, 0, 0) is not a number. An outcome with probability 0 adds nothing, "
            "so skip it before taking a log."
        )
    expected = ", ".join(str(e) for _, e in cases)
    return False, f"Expected entropies {expected} bits; got {_fmt(got)}."


def check_cross_entropy(model, data):
    p = np.array([0.5, 0.25, 0.25])
    q = np.array([0.125, 0.375, 0.5])
    expected = float(np.sum(p * np.log2(1 / q)))
    got = model.cross_entropy(p, q)
    same = model.cross_entropy(p, p)
    zero_in_p = model.cross_entropy(np.array([1.0, 0.0]), np.array([0.5, 0.5]))
    zero_in_q = model.cross_entropy(np.array([0.5, 0.5]), np.array([1.0, 0.0]))
    if _close(got, float(np.sum(q * np.log2(1 / p)))):
        return False, (
            f"H(p, q) came out as {float(got):.4f}, which is H(q, p). Weight each surprise by the "
            f"actual probability p and compute the surprise from the forecast q. Expected {expected:.4f}."
        )
    if _close(got, expected * np.log(2)):
        return False, "Cross-entropy used the natural log. Use log base 2 to get bits."
    if not (_close(got, expected) and _close(same, 1.5)):
        return False, f"For p = (1/2, 1/4, 1/4) and q = (1/8, 3/8, 1/2), expected {expected:.4f} bits; got {float(got):.4f}."
    if not _close(zero_in_p, 1.0):
        return False, f"H((1, 0), (1/2, 1/2)) should be 1 bit, since an outcome that never happens adds nothing; got {zero_in_p}."
    if not (np.isinf(zero_in_q) and zero_in_q > 0):
        return False, (
            f"H((1/2, 1/2), (1, 0)) should be infinite, because the forecast gives 0 to an outcome "
            f"that happens; got {zero_in_q}."
        )
    return True, f"Cross-entropy is {expected:.3f} bits for the test forecast and handles zero probabilities."


def check_bell_forecast(model, data):
    bins = np.arange(95, 106)
    q = np.asarray(model.bell_forecast(bins, 100.0, 2.0), dtype=float)
    if q.shape != bins.shape:
        return False, f"Expected one probability per bin, shape {bins.shape}; got shape {q.shape}."
    if np.any(q < 0) or not np.isclose(q.sum(), 1.0):
        return False, f"The forecast adds up to {q.sum():.4f}. Divide the heights by their total so they add up to 1."
    heights = np.exp(_log_density(bins, 100.0, 2.0))
    expected = heights / heights.sum()
    if not _close(q, expected):
        return False, (
            f"Bin 100 should be e^0.5, about 1.65 times as likely as bin 102 (got {q[5] / q[7]:.3f}). "
            "Use the bell's height at each bin, then divide by their total."
        )
    return True, "The bell forecast is a distribution over the bins, in proportion to the bell's heights."


def check_forecast_cross_entropy(model, data):
    train, held_out = data
    p = np.asarray(model.bin_fractions(held_out, BINS), dtype=float)
    floor = float(model.entropy(p))
    scores = {
        name: float(model.cross_entropy(p, model.bell_forecast(BINS, *fit)))
        for name, fit in _fits(train).items()
    }
    summary = "; ".join(f"{name} {score:.3f}" for name, score in scores.items())
    best = min(scores, key=scores.get)
    if best != "fitted bell":
        return False, f"The bell '{best}' had the lowest cross-entropy on the held-out bins ({summary}). The fitted bell should."
    if scores["fitted bell"] < floor - 1e-9:
        return False, f"Cross-entropy {scores['fitted bell']:.3f} is below the entropy {floor:.3f} bits, which cannot happen."
    return True, f"Entropy of the held-out bins is {floor:.3f} bits. Cross-entropy of each bell: {summary}."


def check_recovers_sensor(model, data, metrics, limits):
    ok = all(
        name in metrics
        and (metrics[name] < limit["threshold"] if limit["direction"] == "below" else metrics[name] > limit["threshold"])
        for name, limit in limits.items()
    )
    detail = ", ".join(
        f"{limits[name]['label']} {metrics[name]:.3f} (must be {limits[name]['direction']} {limits[name]['threshold']})"
        for name in limits
        if name in metrics
    )
    if ok:
        return True, f"The fit recovers the sensor: {detail}."
    return False, f"The fit misses the project targets: {detail or 'metrics could not be computed'}."


CHECKS = [
    ("test_mean_variance_std", check_mean_variance_std),
    ("test_log_density_matches_formula", check_log_density),
    ("test_log_likelihood_is_sum_of_log_densities", check_log_likelihood),
    ("test_fit_uses_mean_and_spread", check_fit_uses_mean_and_spread),
    ("test_sigma_search_agrees_with_fit", check_sigma_search),
    ("test_fit_beats_worse_fits_on_held_out", check_held_out_comparison),
    ("test_entropy_in_bits", check_entropy),
    ("test_cross_entropy_in_bits", check_cross_entropy),
    ("test_bell_forecast_is_a_distribution", check_bell_forecast),
    ("test_bell_forecast_cross_entropy", check_forecast_cross_entropy),
]


def _error_message(error):
    if isinstance(error, NotImplementedError):
        return "Not implemented yet: fill in the TODO functions this check uses."
    return f"{type(error).__name__}: {error}"


def run_checks(model):
    project = yaml.safe_load(PROJECT_FILE.read_text(encoding="utf-8"))
    limits = {metric["id"]: metric for metric in project["metrics"]}
    data = model.make_readings()
    checks = []
    for check_id, check in CHECKS:
        try:
            passed, message = check(model, data)
        except Exception as error:
            passed, message = False, _error_message(error)
        checks.append({"id": check_id, "passed": bool(passed), "message": message})

    metrics = {}
    try:
        train, held_out = data
        mu, sigma = model.fit_gaussian(train)
        metrics = {
            "mean_error": float(abs(mu - TRUE_MU)),
            "sigma_error": float(abs(sigma - TRUE_SIGMA)),
            "held_out_log_likelihood": float(np.mean(_log_density(held_out, mu, sigma))),
        }
        metrics = {name: value for name, value in metrics.items() if np.isfinite(value)}
        passed, message = check_recovers_sensor(model, data, metrics, limits)
    except Exception as error:
        metrics = {}
        passed, message = False, _error_message(error)
    checks.append({"id": "test_fit_recovers_sensor_settings", "passed": bool(passed), "message": message})
    return checks, metrics
