# Post-training a tiny LLM

We will turn a lowercase echo model into an uppercase echo assistant. The model
predicts one token at a time. It has 15 tokens and 1,104 pretrained parameters, so
the whole experiment fits comfortably on a laptop CPU. All text and preference
pairs are generated locally. No model or dataset downloads are used.

The lab always uses CPU arrays. It has no CUDA, MPS, or PyTorch dependency.
NumPy provides native Apple Silicon wheels through the standard PyPI index.

## Setup

Use Python 3.12 or newer. On an Apple Silicon Mac, use a native arm64 Python.
You can keep the dependency in a virtual environment:

```bash
python3 -m venv .venv
source .venv/bin/activate
```

From the repository root:

```bash
python3 -m pip install -r labs/llm-post-training/requirements.txt
python3 labs/llm-post-training/setup.py
python3 labs/llm-post-training/pretrain.py
```

This uses the same NumPy 2.x dependency range as the neural-network lab. Once NumPy
is installed, training and verification work offline. Setup copies the starter to
`work/post_training.py` and preserves it on later runs. Pretraining saves
`work/base.npz` and prints four lowercase responses.

Implement the TODOs in `work/post_training.py`. The data generator, model encoder,
generation loop, and training loops are provided in `tiny_lm.py`.

## The tiny language model

Each word and chat marker is one token. A training sequence looks like this:

```text
<bos> <user> echo red <assistant> RED <eos>
```

`<bos>` begins the sequence. `<user>` and `<assistant>` mark roles. `<eos>` ends
the response. Pretraining uses lowercase answers. SFT uses uppercase answers.
The four words are red, blue, green, and gold. There are eight training prompts.
Eight held-out prompts add `now` before `<assistant>`. No held-out prompt is used
in pretraining, SFT, or reward training. All four word meanings occur in both
splits, so this evaluates new prompt forms using known words.

For each prefix, the encoder input concatenates token counts with a one-hot
representation of its last token. It sees only tokens in that prefix. A trained
tanh layer maps the 30 inputs to 24 hidden features. A matrix `W` of shape
`(15, 24)` maps those features to next-token logits. Pretraining updates the
encoder, bias, and `W` with next-token loss at every position for 1,200 steps.

This is a feedforward autoregressive language model. Its count-based encoder
loses most word order, and the vocabulary is tiny. It demonstrates the
post-training objectives in the unit. Its benchmark measures uppercase echoing.

## 1. Align the response mask

`batch` supplies tokens up to each position as context and the next token as its
target. `response_mask(tokens, response_start)` returns `len(tokens)-1` entries.
Entry zero scores original token index 1. The first response token in the example
above is at index 5, so the target mask is `[0, 0, 0, 0, 1, 1]`.

Done: both response targets count, including `<eos>`, and prompt targets have zero
weight. The prompt remains available to the encoder.

## 2. Initialize and merge the adapter

For `W` of shape `(n_out, n_in)`, initialize `A` with shape `(rank, n_in)` and `B`
with shape `(n_out, rank)`. Start with `np.random.default_rng(seed)`. Draw `A` from
`normal(0, 0.1, (rank, n_in))`, then set `B` to zero.

`adapted_weight(W, A, B)` returns `W + B @ A` and leaves `W` unchanged. The
supplied training loop uses rank 4 and seed 11. It trains 156 numbers, compared
with the output matrix's 360. Every encoder and base output parameter is frozen.

Done: the adapter starts with exactly the base predictions, and applying its two
factors gives the same logits as using the merged weight.

## 3. Calculate response loss and its gradient

`logits` has shape `(n_targets, n_tokens)`; `targets` and `mask` have shape
`(n_targets,)`. Return `(loss, grad)` where `grad` has the same shape as `logits`.

Subtract each row's maximum logit to get `shifted`. Calculate log probabilities
as `shifted - log(sum(exp(shifted)))`, with the sum along each row. Select the log
probability of each target, negate it, multiply by the mask, and divide the sum
by `mask.sum()`. Raise `ValueError` when the mask selects no targets.

For the logit gradient, start with `softmax(logits)`. Subtract one at each target
column, then multiply each row by `mask / mask.sum()`. The supplied `softmax`
helper is numerically stable. Keep the input logits unchanged.

Done: masked prompt predictions cannot change the response loss, masked gradient
rows are zero, and large positive or negative logits produce finite values.

## 4. Take a supervised LoRA step

Use `h = hidden(base, X)` and the effective output matrix to calculate logits.
Call your masked loss. Backpropagate its logit gradient through the factors:

```text
dW = grad.T @ h
dA = B.T @ dW
dB = dW @ A.T
```

Compute both factor gradients using the old factors. Update `A` and `B` in place
with `factor -= learning_rate * gradient`. Return the loss before this update.
The provided loop runs 600 full-batch steps with learning rate 0.3.

Done: the one-step check matches the update equations and the base stays frozen
through the complete training run.

## 5. Train a separate reward model

The generator creates 32 training pairs and 32 held-out pairs. For a given
prompt, the correct uppercase response is chosen over the correct lowercase
response or one of the three wrong uppercase words. These preferences simulate
annotator choices under the echo instruction.

`reward_features` concatenates response-token counts and every product of a
prompt-token count with a response-token count. There is no feature containing a
correctness label. The linear scorer learns which token combinations people
prefer in this synthetic dataset. Its 240 weights start at zero.

Implement `preference_loss(chosen_scores, rejected_scores)`. Use
`difference = chosen_scores - rejected_scores`. The mean Bradley-Terry loss is
`mean(logaddexp(0, -difference))`. A stable preference probability is
`exp(-logaddexp(0, -difference))`. For `n` pairs, the chosen score gradient is
`(probability - 1) / n`, and the rejected gradient is its negative.

Implement `reward_step` by calculating both score arrays, calling the preference
loss, and calculating `chosen.T @ chosen_grad + rejected.T @ rejected_grad`.
Update weights in place and return the loss before the update. The supplied loop
runs 250 steps with learning rate 0.3. The reward model stays separate from the
language model; its scores are used to check preference learning.

Done: gradient signs raise the chosen score relative to the rejected one, loss
falls, and held-out pair accuracy exceeds 0.9. Tied scores count as incorrect
in this pair-ranking metric.

## 6. Evaluate and verify

Implement `win_rate(outcomes)` where 1 means the adapter wins, 0 is a tie, and -1
means the base wins. Award half credit per tie and divide by every comparison.
Raise `ValueError` for an empty comparison array.

```bash
python3 labs/llm-post-training/run.py
python3 labs/verify.py llm-post-training
```

The experiment saves adapter and reward checkpoints plus `work/experiment.json`.
Read all eight greedy response pairs. Exact match requires the expected uppercase
word followed by `<eos>`. The deterministic judge awards a win when only the
adapted answer matches, a loss when only the base matches, and a tie otherwise.
The report includes wins, ties, losses, and the tie-adjusted win rate.

The verifier retrains a fresh seed-7 base each time. It checks your code using
public test inputs and saves `work/results.json`. Upload that file on the project
page. It must pass all ten checks, keep base exact match below 0.25, reach
adapted exact match above 0.9 with improvement above 0.75, get response loss
below 0.1, and rank more than 0.9 of held-out preference pairs correctly.

Eight related prompts give limited evidence. A high score supports this echo
benchmark. New tasks, vocabulary, prompt forms, and human preferences need
separate evaluations. Optional later work can explore DPO and GRPO after their
lessons are available.

## Check the checker

```bash
python3 labs/verify.py llm-post-training --implementation labs/llm-post-training/_solution/post_training.py --output labs/llm-post-training/work/solution-results.json
python3 labs/verify.py llm-post-training --implementation labs/llm-post-training/starter/post_training.py --output labs/llm-post-training/work/starter-results.json
python3 labs/verify.py llm-post-training --implementation labs/llm-post-training/_solution/buggy.py --output labs/llm-post-training/work/buggy-results.json
```

The reference passes every check and metric. The untouched starter fails with
TODO messages. The buggy implementation divides masked loss by all target
positions. Its masking-loss check explains the correct denominator; its one-step
SFT check also fails. The other eight checks pass. Both failing runs return a
nonzero exit code and still write uploadable JSON using the declared test IDs.
