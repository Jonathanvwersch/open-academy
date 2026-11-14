# Linear regression with NumPy

From the repository root, install the local dependencies and copy the starter into your work directory:

```bash
python3 -m pip install -r labs/linreg-numpy/requirements.txt
python3 labs/linreg-numpy/setup.py
```

Implement the TODOs in `labs/linreg-numpy/work/linreg.py`, then run:

```bash
python3 labs/verify.py linreg-numpy
```

The verifier reads the acceptance thresholds from the project YAML and writes `labs/linreg-numpy/work/results.json`; upload that JSON on the Academy lab page. The app validates results as data and never runs learner code.

The reference implementation used by the project tests is in `_solution/`.

Running setup again keeps existing files in `work/`. Use `python3 labs/linreg-numpy/setup.py --force` only
when you want to replace your implementation with the starter.
