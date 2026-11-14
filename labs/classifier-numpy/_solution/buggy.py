import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("reference", Path(__file__).with_name("classifier.py"))
reference = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reference)


def metrics(matrix):
    accuracy, precision, recall = reference.metrics(matrix)
    return accuracy, recall, precision


def __getattr__(name):
    return getattr(reference, name)
