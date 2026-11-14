"""Common mistake: divide masked loss by all targets, including prompt targets."""

import importlib.util
from pathlib import Path


_spec = importlib.util.spec_from_file_location("reference", Path(__file__).with_name("post_training.py"))
_reference = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_reference)
_correct_loss = _reference.masked_loss


def masked_loss(logits, targets, mask):
    loss, grad = _correct_loss(logits, targets, mask)
    factor = mask.sum() / len(mask)
    return loss * factor, grad * factor


_reference.masked_loss = masked_loss


def __getattr__(name):
    return getattr(_reference, name)
