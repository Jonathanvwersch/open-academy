import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location("reference", Path(__file__).with_name("linreg.py"))
_reference = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_reference)


def gradients(X, y, w, b):
    dw, db = _reference.gradients(X, y, w, b)
    return dw / 2, db / 2


def __getattr__(name):
    return getattr(_reference, name)
