# Image classifier

Train a small CNN on noisy bars, then debug its evaluation and compare weight decay.
The project page contains the step-by-step tasks. All images are generated locally.
No pretrained weights, external datasets, GPU or network access are needed to verify.

## Setup

Use Python 3.12 on Linux or Windows with the pinned CPU wheel:

```bash
python3 -m pip install -r labs/image-classifier/requirements.txt
python3 labs/image-classifier/setup.py
```

Setup copies the starter into `work/classifier.py`. It refuses to overwrite existing
work. Edit that file, then run from the repository root:

```bash
python3 labs/verify.py image-classifier
```

On macOS, PyTorch's standard `torch==2.10.0` wheel runs on CPU. The `+cpu` index
provides Linux and Windows wheels. Verification uses one CPU thread and normally
takes a few seconds. Installation needs internet access once.

## Data and contracts

`data.py` uses seed 2026 and returns three independent balanced splits of sizes
240, 80 and 80. Images are float32 tensors shaped `(N, 1, 12, 12)`. Targets are
float32 tensors shaped `(N,)`. Class 0 is a horizontal bar; class 1 is vertical.
Each bar has width two, random position and a noisy background. There are no
augmented copies shared between splits.

- `normalize(train, validation, test)` returns new scaled tensors. Fit one scalar
  mean and population standard deviation on training pixels. Clamp the standard
  deviation at `1e-6`. Reuse the same values on validation and test pixels.
- `build_model(seed)` returns a seeded CNN with one raw logit per image. The
  starter specifies each layer, so you can focus on tensor shapes and training.
- `train_epoch(model, x, y, optimizer, batch_size, seed)` updates the supplied
  model once per shuffled mini-batch. Clear gradients each time. Use mean binary
  cross-entropy on logits. A final partial batch still gets an update. An empty
  batch collection needs no updates.
- `evaluate(model, x, y)` returns `(loss, accuracy)` as Python numbers for nonempty
  inputs. Disable dropout and gradient recording. Use threshold zero on logits.
  Training re-enables dropout at the next epoch.
- `choose_checkpoint(records)` returns the index of the first smallest
  `validation_loss`. Raise `ValueError` on empty input. Records include training
  loss, but only validation loss chooses a checkpoint.

`experiment.py` supplies Adam, checkpoint copies and final test evaluation. Both
weight-decay settings (0 and 0.01) use initialization seed 7 and the same shuffled
mini-batches. Each trains for 12 epochs at learning rate 0.01, batch size 32.
The selected checkpoint across all 24 records is restored before one test score.
Changing test scores must never influence this choice.

## Debug and compare

The starter has a planted error in `evaluate`. After filling the other TODOs,
look at `test_evaluation_mode`. Fix the mode and gradient behavior, then verify
that repeated evaluation agrees. Explain the symptom and fix in `work/notes.md`.

The verifier writes `work/history.json` alongside `work/results.json`. Compare
training and validation loss for both decay settings in a small plot or table.
Record each setting's best validation epoch and loss in your notes. Explain any
interval where training loss falls while validation loss rises. If none occurs,
record that observation. This easy dataset does not guarantee an overfitting gap
or an improvement from weight decay. Notes and plots are for your own review;
the automated checks cover the executable contracts and metrics.

Upload `work/results.json` on the project page. The verifier exits nonzero on a
failed check and still writes JSON with helpful messages. It checks normalization,
architecture, updates, evaluation, checkpoint selection, the controlled comparison
and held-out performance. The default thresholds are 0.90 validation/test accuracy
and test loss below 0.30.

## Reference and checker proof

`_solution/classifier.py` is a complete reference. Try the tasks before reading it.
`_solution/buggy.py` keeps the evaluation bug while implementing everything else.
The TypeScript tests run the reference, untouched starter and buggy variant. You
can choose an implementation and output path explicitly:

```bash
python3 labs/verify.py image-classifier --implementation labs/image-classifier/_solution/classifier.py
```

`--seed` changes model initialization and batch ordering for reference robustness
checks. Dataset seed stays fixed so the split stays comparable.
