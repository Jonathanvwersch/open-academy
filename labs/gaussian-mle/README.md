# Fitting a Gaussian

In this project, we fit a bell curve to noisy readings from a distance sensor. The sensor is aimed at a wall 100 cm away, its noise has standard deviation 2 cm, and it reports whole centimetres. A seeded generator makes 400 readings: 200 for training and 200 held out to test the fit.

## Setup

From the repository root, install the dependencies and copy the starter into your work directory:

```bash
python3 -m pip install -r labs/gaussian-mle/requirements.txt
python3 labs/gaussian-mle/setup.py
```

Edit `labs/gaussian-mle/work/gaussian.py`. `make_readings` and `bin_fractions` are done for you. Fill in every function marked TODO. Everything runs offline on a laptop in a few seconds.

## Tasks

1. **Centre and spread.** `mean`, `variance` and `std`. With `sample=False`, divide the squared deviations by $n$. With `sample=True`, divide by $n-1$.
2. **Log of the bell's height.** `log_density(x, mu, sigma)` returns $\ln f(x)=\ln\frac{1}{\sigma\sqrt{2\pi}}-\frac{(x-\mu)^2}{2\sigma^2}$ for one reading or an array. Keep both terms.
3. **Log-likelihood.** `log_likelihood` adds the log heights of independent readings.
4. **Fit.** `fit_gaussian` returns the mean and the divide-by-$n$ standard deviation.
5. **Search for the best spread.** `best_sigma` keeps $\mu$ fixed and returns the value in `sigmas` with the highest log-likelihood. It should agree with `fit_gaussian`.
6. **Held-out score.** `average_log_likelihood` divides the log-likelihood by the number of readings. Your fit should beat a shifted bell, a wider bell and a narrower bell on the held-out readings.
7. **Entropy and cross-entropy.** `entropy(p)` and `cross_entropy(p, q)` in bits, with `np.log2`. Skip outcomes with $p_i=0$. Return `float("inf")` when $q_i=0$ for an outcome that can happen.
8. **Bell as a forecast.** `bell_forecast(bins, mu, sigma)` takes the bell's height at each whole-centimetre bin and divides by their total.

## Run the verifier

```bash
python3 labs/verify.py gaussian-mle
python3 labs/gaussian-mle/work/report.py
```

The verifier writes `labs/gaussian-mle/work/results.json`. It reads the metric thresholds from `labs/gaussian-mle/project.yaml` and reports three metrics: the error of the fitted mean, the error of the fitted standard deviation, and the held-out average log-likelihood per reading. `report.py` prints the fit and the comparisons to other models.

## Common bugs

- **Dropping the front factor.** The maximum-likelihood lesson drops $\ln\frac{1}{\sigma\sqrt{2\pi}}$ because it is the same for every $\mu$. Here you also fit $\sigma$, and that term changes with $\sigma$. Without it, the widest bell always wins.
- **Taking the log of a product.** Multiplying 200 heights is fine, but 5000 rounds to 0. Add log heights instead.
- **Dividing by $n-1$ in the fit.** The sample variance is a good estimate of spread, but the maximum-likelihood $\sigma$ divides by $n$.
- **Using the natural log for entropy.** Entropy and cross-entropy here are in bits, so use base 2.
- **Swapping $p$ and $q$.** In $H(p,q)$, the actual probabilities $p$ are the weights and the forecast $q$ gives the surprise.

The reference implementation used by the project tests is in `_solution/gaussian.py`. `_solution/buggy.py` drops the front factor, and the verifier shows which checks catch it.
