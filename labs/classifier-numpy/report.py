"""Provided reporting and I/O. Run after completing work/classifier.py."""
import importlib.util
from pathlib import Path
import numpy as np

path = Path(__file__).resolve().parent / "work" / "classifier.py"
spec = importlib.util.spec_from_file_location("classifier", path)
model = importlib.util.module_from_spec(spec)
spec.loader.exec_module(model)

for classes in (2, 3):
    X, y, X_val, y_val = model.make_data(classes)
    w, b, history = model.train(X, y, classes)
    logits = X_val @ w + b
    predicted = (model.sigmoid(logits) >= 0.5).astype(int) if classes == 2 else np.argmax(model.softmax(logits), axis=1)
    matrix = model.confusion_matrix(y_val, predicted, classes)
    accuracy, precision, recall = model.metrics(matrix)
    print(f"{classes} classes: loss {history[0]:.4f} -> {history[-1]:.4f}")
    print("Validation confusion matrix (true rows, predicted columns):")
    print(matrix)
    print(f"Accuracy: {accuracy:.4f}")
    print("Precision by class:", precision)
    print("Recall by class:", recall)
