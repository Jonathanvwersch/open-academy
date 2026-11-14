import math
from unittest.mock import patch

import torch
from torch import nn

from data import data
from experiment import EPOCHS, SETTINGS, experiment


IDS = ["test_train_only_normalization", "test_cnn_shapes_and_seed",
       "test_minibatch_updates", "test_evaluation_mode", "test_validation_selection",
       "test_regularization_comparison", "test_held_out_accuracy"]


def run(candidate, seed):
    checks, metrics, records = [], {}, []

    def check(name, function):
        try:
            function()
            checks.append(dict(id=name, passed=True, message="ok"))
        except Exception as error:
            checks.append(dict(id=name, passed=False,
                               message=f"{type(error).__name__}: {error}"))

    def normalization():
        train = torch.arange(24, dtype=torch.float32).reshape(2, 1, 3, 4)
        validation, test = train + 100, train - 200
        originals = [x.clone() for x in (train, validation, test)]
        outputs = candidate.normalize(train, validation, test)
        assert len(outputs) == 3, "Return train, validation, test in that order."
        for output, original, source in zip(outputs, originals, (train, validation, test)):
            expected = (original - originals[0].mean()) / originals[0].std(unbiased=False)
            assert torch.allclose(output, expected), "Fit statistics on train only; reuse them on both held-out sets."
            assert torch.equal(source, original), "Keep the supplied raw tensors unchanged."
        constants = candidate.normalize(*(torch.ones(2, 1, 12, 12) for _ in range(3)))
        assert all(torch.isfinite(x).all() for x in constants), "Clamp a zero standard deviation."

    def architecture():
        model = candidate.build_model(seed)
        other = candidate.build_model(seed)
        assert isinstance(model, nn.Module), "Return a PyTorch module."
        assert all(torch.equal(a, b) for a, b in zip(model.parameters(), other.parameters())), "Seed parameter initialization."
        assert any(isinstance(m, nn.Conv2d) for m in model.modules()), "Include a learned spatial convolution."
        assert any(isinstance(m, nn.Dropout) and m.p == 0.25 for m in model.modules()), "Include dropout with probability 0.25."
        for count in (1, 5):
            output = model(torch.zeros(count, 1, 12, 12))
            assert output.shape == (count, 1), "Return one raw binary logit per image, shaped (batch, 1)."
            assert torch.isfinite(output).all(), "Logits must be finite."

    def minibatches():
        model = nn.Sequential(nn.Flatten(), nn.Linear(144, 1))
        model.eval()
        (x, y), _, _ = data()
        x, y = x[:65], y[:65]
        optimizer = torch.optim.SGD(model.parameters(), lr=0.1)
        seen, steps, clears = [], [], []
        handle = model.register_forward_pre_hook(lambda m, args: seen.append((m.training, args[0].clone())))
        before = [p.detach().clone() for p in model.parameters()]
        try:
            with patch.object(optimizer, "step", wraps=optimizer.step) as step, patch.object(optimizer, "zero_grad", wraps=optimizer.zero_grad) as clear:
                candidate.train_epoch(model, x, y, optimizer, 32, 9)
                steps.append(step.call_count)
                clears.append(clear.call_count)
        finally:
            handle.remove()
        assert steps == clears == [3], "For 65 images at batch size 32, clear gradients and step exactly three times."
        assert len(seen) == 3 and all(mode for mode, _ in seen), "Use training mode for each mini-batch."
        expected = torch.randperm(65, generator=torch.Generator().manual_seed(9))
        assert torch.equal(torch.cat([batch for _, batch in seen]), x[expected]), "Visit each image once in seeded shuffled mini-batches, including the last partial batch."
        reference = nn.Sequential(nn.Flatten(), nn.Linear(144, 1))
        with torch.no_grad():
            for p, initial in zip(reference.parameters(), before):
                p.copy_(initial)
        ref_optimizer = torch.optim.SGD(reference.parameters(), lr=0.1)
        for indices in expected.split(32):
            ref_optimizer.zero_grad()
            loss = nn.functional.binary_cross_entropy_with_logits(reference(x[indices]).squeeze(1), y[indices])
            loss.backward()
            ref_optimizer.step()
        assert all(torch.allclose(a, b, atol=1e-6) for a, b in zip(model.parameters(), reference.parameters())), "Use mean binary loss on raw logits and clear gradients before every backward pass."
        with patch.object(optimizer, "step", wraps=optimizer.step) as step:
            candidate.train_epoch(model, x[:0], y[:0], optimizer, 32, 9)
            assert step.call_count == 0, "An empty training collection needs no updates."

    def evaluation():
        model = nn.Sequential(nn.Flatten(), nn.Dropout(0.75), nn.Linear(144, 1))
        model.train()
        (x, y), _, _ = data()
        observations = []
        handle = model.register_forward_pre_hook(lambda m, args: observations.append((m.training, torch.is_grad_enabled())))
        before = [p.detach().clone() for p in model.parameters()]
        try:
            first = candidate.evaluate(model, x[:40], y[:40])
            second = candidate.evaluate(model, x[:40], y[:40])
        finally:
            handle.remove()
        assert observations and all(not mode and not grad for mode, grad in observations), "Validation ran with dropout or gradients active. Call model.eval() and use torch.no_grad() inside evaluate."
        assert first == second, "Repeated evaluation must give the same score."
        with torch.no_grad():
            logits = model(x[:40]).squeeze(1)
            expected = (float(nn.functional.binary_cross_entropy_with_logits(logits, y[:40])),
                        float(((logits >= 0) == y[:40].bool()).float().mean()))
        assert all(abs(a - b) < 1e-6 for a, b in zip(first, expected)), "Report mean binary loss and accuracy using logit threshold zero."
        assert all(torch.equal(a, b) for a, b in zip(before, model.parameters())), "Evaluation must leave weights unchanged."

    def selection():
        for rows, expected in [([dict(train_loss=0.1, validation_loss=0.4), dict(train_loss=0.2, validation_loss=0.3)], 1),
                               ([dict(train_loss=0.2, validation_loss=0.3), dict(train_loss=0.1, validation_loss=0.4)], 0),
                               ([dict(train_loss=0.2, validation_loss=0.3), dict(train_loss=0.1, validation_loss=0.3)], 0)]:
            assert candidate.choose_checkpoint(rows) == expected, "Keep the first lowest validation loss, independent of training loss or row order."
        try:
            candidate.choose_checkpoint([])
        except ValueError:
            pass
        else:
            raise AssertionError("Raise ValueError when no checkpoints are available.")

    def comparison():
        nonlocal records
        rows, selected, test_loss, test_accuracy = experiment(candidate, seed)
        records = rows
        assert len(rows) == EPOCHS * len(SETTINGS)
        assert {(r["weight_decay"], r["dropout"]) for r in rows} == set(SETTINGS)
        assert selected == min(range(len(rows)), key=lambda i: rows[i]["validation_loss"]), "Select across both runs using validation loss."
        assert all(math.isfinite(r[k]) for r in rows for k in ("train_loss", "validation_loss")), "Training produced nonfinite losses."
        metrics.update(validation_accuracy=rows[selected]["validation_accuracy"],
                       test_accuracy=test_accuracy, test_loss=test_loss)
        baseline = [r for r in rows if r["weight_decay"] == 0]
        regularized = [r for r in rows if r["weight_decay"] > 0]
        best_baseline = min(baseline, key=lambda r: r["validation_loss"])
        best_regularized = min(regularized, key=lambda r: r["validation_loss"])
        rise = baseline[-1]["validation_loss"] - best_baseline["validation_loss"]
        regularized_rise = regularized[-1]["validation_loss"] - best_regularized["validation_loss"]
        ratio = regularized_rise / rise if rise > 0 else math.inf
        metrics.update(baseline_overfit_rise=rise, overfit_rise_ratio=ratio)
        assert best_baseline["epoch"] < EPOCHS - 5, "The baseline should reach its validation minimum before training ends."
        assert baseline[-1]["train_loss"] < best_baseline["train_loss"] * 0.5, "After the baseline validation minimum, training loss should fall by more than half. Check that training continues for all epochs."
        assert rise > 0.15, "The unregularised baseline should overfit: final validation loss must exceed its minimum by more than 0.15. Check that baseline dropout and weight decay are both zero."
        assert ratio < 0.3, "Regularisation should limit the validation-loss rise to less than 30% of the baseline rise. Check dropout, weight decay and evaluation mode."

    def quality():
        assert metrics, "Complete the controlled regularization experiment first."
        assert metrics["validation_accuracy"] > 0.74, "Validation accuracy should exceed 0.74. Check training mode, gradients and image layout."
        assert metrics["test_accuracy"] > 0.65, "The selected model should exceed 0.65 accuracy on unseen test images."
        assert metrics["test_loss"] < 0.65, "Test binary loss should fall below 0.65."

    for name, function in zip(IDS, (normalization, architecture, minibatches, evaluation, selection, comparison, quality)):
        check(name, function)
    return checks, metrics, records
