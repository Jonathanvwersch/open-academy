# Image classifier

Train a small CNN on noisy bars, diagnose overfitting, then compare regularisation.
The project page contains the step-by-step tasks. All images are generated locally.
No pretrained weights, external datasets, GPU or network access are needed to verify.

## Setup

Use Python 3.12 on macOS, Linux or Windows. The standard PyPI dependency works on
Apple Silicon Macs:

```bash
python3 -m pip install -r labs/image-classifier/requirements.txt
python3 labs/image-classifier/setup.py
```

Setup copies the starter into `work/classifier.py`. It refuses to overwrite existing
work. Edit that file, then run from the repository root:

```bash
python3 labs/verify.py image-classifier
```

All models, tensors and shuffled indices use `device="cpu"`. The lab never selects
CUDA or MPS. Verification uses one CPU thread and normally takes a few seconds.
Installation needs internet access once. On Linux, a smaller CPU-only wheel is an
optional alternative to the standard PyPI installation:

```bash
python3 -m pip install 'torch>=2.2,<3' --index-url https://download.pytorch.org/whl/cpu
```

## Data and contracts

`data.py` uses seed 2026 and returns three independent balanced splits of sizes
96, 400 and 400. Images are float32 tensors shaped `(N, 1, 12, 12)`. Targets are
float32 tensors shaped `(N,)`. Class 0 is a horizontal bar; class 1 is vertical.
Each bar has width two, random position and adds 0.8 to a background of Gaussian
noise with standard deviation 0.5. These synthetic pixel intensities are unbounded.
After drawing each split, the generator reverses one eighth of the labels, choosing
equal numbers from each class. This models annotation mistakes and keeps target
classes balanced. There are no augmented copies shared between splits.

- `normalize(train, validation, test)` returns new scaled tensors. Fit one scalar
  mean and population standard deviation on training pixels. Clamp the standard
  deviation at `1e-6`. Reuse the same values on validation and test pixels.
- `build_model(seed)` returns a seeded CNN with one raw logit per image. The
  starter specifies each layer, so you can focus on tensor shapes and training.
  Return the model on CPU. The runner sets dropout probability for each experiment.
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

`experiment.py` supplies Adam, checkpoint copies and final test evaluation. The
baseline uses weight decay 0 and dropout 0. The regularised run uses weight decay
0.1 and dropout 0.25. Both use initialization seed 7 and the same shuffled
mini-batches. Each trains for 100 epochs at learning rate 0.01, batch size 32.
The selected checkpoint across all 200 records is restored before one test score.
This comparison measures the combined effect of weight decay and dropout. To
separate their effects, try the follow-up experiment on the project page.
Changing test scores must never influence checkpoint selection.

## Debug and compare

The starter has a planted error in `evaluate`. After filling the other TODOs,
look at `test_evaluation_mode`. Fix the mode and gradient behavior, then verify
that repeated evaluation agrees. Explain the symptom and fix in `work/notes.md`.

The verifier writes `work/history.json` alongside `work/results.json`. Compare
training and validation loss for both settings in a small plot or table. Record
each setting's best validation epoch and loss in your notes, along with its final
training and validation losses. The baseline fits the small training sample and
its incorrect labels. Its training loss keeps falling after the validation minimum,
while validation loss rises. Explain why this shows overfitting. For each run,
subtract its best validation loss from its final validation loss. The regularised
run has a much smaller rise. Divide its rise by the baseline rise and record this
ratio. Compare the best validation losses too, then select the checkpoint with
the lowest validation loss across both runs. Notes and plots are for your own review;
the automated checks require the overfitting pattern and regularisation benefit.

Upload `work/results.json` on the project page. The verifier exits nonzero on a
failed check and still writes JSON with helpful messages. It checks normalization,
architecture, updates, evaluation, checkpoint selection, the controlled comparison
and held-out performance. The accuracy thresholds are above 0.74 on validation and
above 0.65 on test; test loss must be below 0.65. The baseline's final validation
loss must exceed its minimum by more than 0.15, with training loss falling by more
than half after that minimum. The metric `overfit_rise_ratio` divides the regularised
rise by the baseline rise and must be below 0.30. There is no minimum improvement
required in the best validation loss. Either run can supply the selected checkpoint.

These limits have margin across initialization and batch-order seeds 1, 7, 19, 42
and 91 on CPU. Different PyTorch releases and CPU platforms can produce small
numerical differences, so the checker focuses on the large reduction in validation
loss rise. It does not require one regularisation setting to win checkpoint selection.

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
