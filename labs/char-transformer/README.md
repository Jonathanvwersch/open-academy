# Character-level transformer

We build a one-block decoder and train it on the committed story in `text.txt`.
The project page gives the ordered tasks. Work in `work/model.py`.
The TODO functions contain the model ideas. Data loading, modules, training,
initialization and the command-line runner are supplied.

## Setup

From the repository root, with Python 3.10 or newer:

```bash
python3 -m venv ~/ct-venv
source ~/ct-venv/bin/activate
pip install -r labs/char-transformer/requirements.txt
python3 labs/char-transformer/setup.py
# Edit labs/char-transformer/work/model.py
python3 labs/verify.py char-transformer
python3 labs/char-transformer/run.py
```

Install once with internet access. The pinned torch CPU wheel is for Linux/Windows
x86-64. All training and checks then run locally and offline. Upload
`labs/char-transformer/work/results.json` on the project page.
Setup refuses to overwrite existing work. Move your file aside if you want a reset.
The verifier returns exit code 1 for failed checks and still writes results.

## Shapes and order

| Quantity                          | Shape                          |
| --------------------------------- | ------------------------------ |
| Character IDs                     | (batch, time)                  |
| Token plus position embeddings    | (batch, time, 32)              |
| Queries, keys and values per head | (batch, 4, time, 8)            |
| Attention scores and weights      | (batch, 4, time, time)         |
| Joined heads                      | (batch, time, 32)              |
| Vocabulary logits                 | (batch, time, vocabulary size) |

The mask allows the diagonal and every earlier key. Softmax runs along the last
axis. Check row sums as well as zero future weights. Masking probabilities after
softmax can leave row sums below one.

Splitting heads changes axis order as well as shape. Use a numbered tensor to
check that each head receives the correct contiguous feature slice.
The second residual starts from the result of the first residual.

## Reproducible CPU training

Keep the supplied scaffold unchanged for verification. It uses one CPU thread,
width 32, four heads, one pre-norm block, context 32 and batch size 16.
The MLP has hidden width 128 and ReLU. Linear and embedding weights use a normal
distribution with mean 0 and standard deviation 0.02. Linear biases are zero.
Layer normalization keeps its default unit scales and zero biases.
There is no dropout.

`torch.manual_seed(seed)` runs before model construction. A separate
`torch.Generator` seeded with `seed + 1000` draws training windows.
AdamW uses step size 0.003 and weight decay 0.01 for 250 updates.
Cross-entropy averages over batch and time. Evaluation compares the same 16
windows before and after training. This checks learning of the training story;
it supplies no held-out estimate.

The reference seed sweep on this VM gave:

| Seed | Initial loss | Final loss | Ratio    | Training seconds |
| ---- | ------------ | ---------- | -------- | ---------------- |
| 1    | 3.352865     | 1.206232   | 0.359761 | 1.664            |
| 7    | 3.331620     | 1.059369   | 0.317974 | 0.776            |
| 19   | 3.347798     | 1.107687   | 0.330870 | 0.774            |
| 42   | 3.317089     | 1.076445   | 0.324515 | 0.841            |
| 123  | 3.332776     | 1.043715   | 0.313167 | 0.797            |

The first run includes optimizer startup. Thresholds of loss below 2.1 and ratio
below 0.7 allow room for CPU variation. Verification uses seed 7.
Larger models and longer contexts can increase runtime quickly.

`run.py --seed 19` trains and prints a sample with another seed.
`generate` uses a separate seeded generator, crops context to 32, and samples one
character at a time. The sample may repeat phrases from this very small story.

## Maintainer checks

```bash
python3 labs/verify.py char-transformer --implementation labs/char-transformer/_solution/model.py
python3 labs/verify.py char-transformer --implementation labs/char-transformer/starter/model.py
python3 labs/verify.py char-transformer --implementation labs/char-transformer/_solution/buggy.py
pnpm exec vitest run labs
```

Activate the venv first so the Vitest subprocesses find torch and the other labs'
dependencies. The existing NumPy labs additionally need their requirements.
The untouched starter fails all nine checks. The buggy reference omits the causal
mask. It fails the mask check, the exact attention check and the end-to-end
causality check, even if its training loss falls.

## Text provenance

`text.txt` is an original short story written for this project and released with
the repository license. Four copies provide a few KB of local training text.
It contains no downloaded passages or external data dependencies.
