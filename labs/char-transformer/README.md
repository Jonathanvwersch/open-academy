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

Install once with internet access. PyPI provides torch wheels for Apple Silicon
Macs. All model parameters, data and random generators stay on CPU by default.
The code requires neither CUDA nor MPS. All training and checks then run locally
and offline. Upload
`labs/char-transformer/work/results.json` on the project page.
Setup refuses to overwrite existing work. Move your file aside if you want a reset.
The verifier returns exit code 1 for failed checks and still writes results.

For a CPU-only build on Linux, replace the dependency-install command with:

```bash
pip install 'torch>=2.2,<3' --index-url https://download.pytorch.org/whl/cpu
```

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
Cross-entropy averages over batch and time. Split the character IDs at
`int(0.9 * len(data))`. Training windows and their targets use only the first
90%. The final 10% is held out from every optimizer update.
Training evaluation compares the same 16 windows before and after training.
Validation uses complete 32-character windows starting at offsets 0, 32, 64 and
so on within the held-out suffix, each with its shifted next-character targets.
It uses no random draws. The committed text gives 3,858 training characters and
429 validation characters, with 13 validation windows.

Validation loss checks prediction at held-out positions. The story repeats four
times, so these windows contain phrases also found in training. This small check
does not establish performance on a different book.

The reference seed sweep on this VM gave:

| Seed | Initial train loss | Final train loss | Train ratio | Untrained val loss | Final val loss | Training seconds |
| ---- | ------------------ | ---------------- | ----------- | ------------------ | -------------- | ---------------- |
| 1    | 3.352865           | 0.946595         | 0.282324    | 3.353893           | 1.198988       | 0.780            |
| 7    | 3.331620           | 1.039933         | 0.312140    | 3.334648           | 1.297887       | 0.853            |
| 19   | 3.347798           | 1.009388         | 0.301508    | 3.331169           | 1.233843       | 0.764            |
| 42   | 3.317089           | 1.045485         | 0.315182    | 3.324966           | 1.315971       | 0.755            |
| 123  | 3.332776           | 1.038537         | 0.311613    | 3.336796           | 1.275457       | 0.793            |

Measured with torch 2.5.1+cpu on this Linux VM. These timed training runs follow
an untrained evaluation, so optimizer startup has already happened.
The existing training thresholds stay at loss below 2.1 and ratio below 0.7.
The validation threshold is 1.8, about 0.48 above the worst trained validation
loss of 1.315971. It is clearly below the lowest untrained validation loss of
3.324966. This margin allows room for CPU and torch version variation.
Verification uses seed 7.
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
