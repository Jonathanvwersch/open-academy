# Gradient checker

Build a local NumPy tool that checks hand-derived gradients against nearby function values.
The public verifier runs on a laptop CPU in seconds. It generates all points in code.
There are no downloads at check time.

## Setup

From the repository root:

```bash
python3 -m pip install -r labs/gradient-check/requirements.txt
python3 labs/gradient-check/setup.py
```

Install NumPy once before working offline. Edit `labs/gradient-check/work/gradient_check.py`.
Setup refuses to overwrite your work. Keep notes in `work/derivations.md`.
The work directory is ignored by Git.

## Build in small steps

1. Implement `derivative(f, x, eps=1e-5)` with the central difference
   `(f(x + eps) - f(x - eps)) / (2 * eps)`. Return a scalar.
   Check the slope of `x**3 - 2*x` at 1: it is close to 1.
2. Implement `numerical_gradient(f, point, eps=1e-5)`.
   The input is a one-dimensional NumPy vector. Copy it for each coordinate.
   Change only that coordinate and return a vector of the same shape.
   Leave the input unchanged. An empty vector returns an empty vector.
   Both finite-difference functions must raise `ValueError` for nonpositive or nonfinite eps.
3. Derive the gradients of these functions on paper and save your work in the note:
   - `bowl`: `(x - 1)**2 + 2*(y + 2)**2`
   - `coupled`: `(x*y + 1)**2`
   - `composed`: `(x + 2*y)**4`
     Name each inner quantity and include its rate of change.
     Implement `analytic_gradient(name, point)` returning a NumPy vector in x, y order.
     Raise `ValueError` for an unknown name.
4. Implement `relative_error(analytic, numeric)` as
   `norm(analytic - numeric) / max(1e-12, norm(analytic) + norm(numeric))`.
   Use `np.linalg.norm` to measure vector length.
   Zero vectors and empty vectors have error zero.
   Implement `check_gradient(f, grad, point, eps=1e-5)` to return this scalar error.
   Correct gradients must give error below 1e-5 at the public points.
   Try reversing a gradient to see a large error.
5. Compare eps values 0.1, 1e-5 and 1e-12 on composed at (0.3, -0.7).
   Record each error and explain which is smallest.
   A large interval includes curvature. Tiny intervals can lose precision in subtraction.
   You review this note yourself; the verifier checks the code.
6. Implement `walk_downhill(f, grad, start, step_size=0.1, steps=80)`.
   Subtract `step_size * grad(point)` each time.
   Return arrays `(path, values)` of shapes `(steps + 1, 2)` and `(steps + 1,)`.
   Include the starting point. Save independent copies and leave start unchanged.
   Zero steps returns only the start.
   Walk on bowl from (4, 3). Finish near (1, -2) with height below 1e-8.

Run a walk from your Python interpreter after finishing the functions:

```python
import numpy as np
from gradient_check import analytic_gradient, check_gradient, walk_downhill

f = lambda p: (p[0] - 1)**2 + 2*(p[1] + 2)**2
grad = lambda p: analytic_gradient("bowl", p)
print("Relative error:", check_gradient(f, grad, np.array([4., 3.])))
path, values = walk_downhill(f, grad, np.array([4., 3.]))
print("Final point and height:", path[-1], values[-1])
```

Start the interpreter from `labs/gradient-check/work` so it can import your file.

## Verify

From the repository root:

```bash
python3 labs/verify.py gradient-check
```

Upload `labs/gradient-check/work/results.json` on the project page.
Seven checks cover scalar slopes, partials, analytic gradients, relative error,
the integrated checker, downhill updates and edge cases.
Metrics report the maximum relative error and final bowl height.
Failed checks include a hint. An unimplemented function reports its TODO message.

For a verifier self-check:

```bash
python3 labs/verify.py gradient-check --implementation labs/gradient-check/_solution/gradient_check.py
python3 labs/verify.py gradient-check --implementation labs/gradient-check/starter/gradient_check.py
python3 labs/verify.py gradient-check --implementation labs/gradient-check/_solution/buggy.py
```

The solution passes. The starter fails. The buggy version omits the inner factor of
2 in the composed function's y partial. The analytic and integrated checks reject it.

## Common mistakes

- Changing both coordinates measures a directional change. Copy and change one coordinate per partial.
- Dividing by eps doubles a central-difference slope. The interval has width 2 * eps.
- Leaving out an inner factor gives a wrong composed gradient.
- An absolute difference depends on scale. Use the specified relative error.
- Adding the gradient moves uphill for a small positive step.
- Saving the same mutable array repeatedly loses the earlier points.
