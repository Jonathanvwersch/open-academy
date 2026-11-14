from pathlib import Path
import runpy

globals().update({
    key: value for key, value in runpy.run_path(
        str(Path(__file__).with_name("classifier.py"))
    ).items() if not key.startswith("__")
})


def evaluate(model, x, y):
    model.train()
    logits = model(x).squeeze(1)
    loss = nn.functional.binary_cross_entropy_with_logits(logits, y)
    accuracy = ((logits >= 0) == y.bool()).float().mean()
    return float(loss.detach()), float(accuracy)
