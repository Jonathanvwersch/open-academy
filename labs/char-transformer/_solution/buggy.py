import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location("reference", Path(__file__).with_name("model.py"))
_reference = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_reference)


def attention(q, k, v):
    scores = q @ k.transpose(-2, -1) / q.shape[-1] ** 0.5
    weights = scores.softmax(dim=-1)
    return weights @ v, weights


_reference.attention = attention


def __getattr__(name):
    return getattr(_reference, name)
