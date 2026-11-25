# PCA from scratch

Implement the TODOs in `work/pca.py`. Examples are rows, features are columns.
All data generation, image output and result serialization are provided.
The data has 160 images with 64 pixels each. It is generated offline with seed 17.

From the repository root:

```bash
python3 -m pip install -r labs/pca-numpy/requirements.txt
python3 labs/pca-numpy/setup.py
# edit labs/pca-numpy/work/pca.py
python3 labs/verify.py pca-numpy
python3 labs/pca-numpy/preview.py
```

Setup refuses to overwrite existing work. The verifier writes
`labs/pca-numpy/work/results.json`, including when checks fail.
Upload that file at `/projects/pca-numpy`.

## Function contracts

- `centre(X)`: return `(Xc, mean)` with a mean per feature.
- `covariance(Xc)`: return `Xc.T @ Xc / (n - 1)`. Reject fewer than two rows.
- `eigen_pca(C)`: use `eigh`; return values descending and matching unit columns.
- `svd_pca(Xc)`: return squared singular values divided by `n - 1` and right singular vectors as columns.
- `direction_agreement(V, W)`: absolute dot products of matching unit columns.
  A sign flip gives the same PCA direction. Repeated eigenvalues may also
  rotate their shared space; the public direction comparison uses distinct values.
- `project(Xc, V, k)`: keep the leading `k` columns, including zero columns.
  Reject noninteger or out-of-range `k` with `ValueError`.
- `reconstruct(Z, V, mean)`: map back through the retained directions and restore the mean.
- `reconstruction_error(X, reconstructed)`: average squared difference per entry.
- `explained_variance(values)`: clip negative roundoff, divide by the total,
  and return zeros for a zero total.

Inputs are finite, nonempty two-dimensional arrays with compatible shapes,
except that projected coordinates may have zero columns. Covariance needs
at least two rows. You do not need to write general input validation beyond
the stated row-count and k checks.

## Inspect the output

Open `work/reconstructions.pgm` in an image viewer. Rows show eight originals,
then reconstructions with k=0, 1, 2, 3 and 8. Display values are clipped to
[0, 1]. Error calculations use the original real-valued arrays.

The verifier sweeps k=0, 1, 2, 3, 8 and 64. Three components should retain
more than 0.98 of variance with average squared pixel error below 0.0002.
The reference gives about 0.9937 and 0.000093 respectively.
At k=64 reconstruction should be exact up to floating point roundoff.
Checks use independent small matrices to isolate mistakes in each function.

## Checker fixtures

`_solution/pca.py` is the reference. `_solution/buggy.py` forgets to centre.
Run either with `--implementation PATH`; use `--output PATH` to preserve results.
The buggy version fails `test_centre` and the image compression check.
The untouched starter fails all nine checks with actionable TODO messages.

NumPy and PyYAML use the same major-version bounds as the existing labs.
The verifier and preview only require NumPy. No network access is needed
after dependencies are installed.
