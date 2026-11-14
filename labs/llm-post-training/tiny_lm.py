"""Provided data, causal prefix encoder, and CPU training plumbing."""

from pathlib import Path

import numpy as np


WORDS = ("red", "blue", "green", "gold")
VOCAB = ("<bos>", "<user>", "<assistant>", "<eos>", "echo", "please", "now", *WORDS, *(w.upper() for w in WORDS))
TOKEN = {word: index for index, word in enumerate(VOCAB)}
V = len(VOCAB)
HIDDEN = 24
RANK = 4


def examples(split="train", uppercase=True):
    """Hold out whole prompts. All four word meanings occur in training."""
    templates = {
        "train": ("echo {word}", "please echo {word}"),
        "validation": ("echo {word} now", "please echo {word} now"),
    }
    return [
        {
            "prompt": f"<bos> <user> {template.format(word=word)} <assistant>",
            "response": f"{word.upper() if uppercase else word} <eos>",
        }
        for template in templates[split]
        for word in WORDS
    ]


def encode(text):
    return np.array([TOKEN[word] for word in text.split()], dtype=int)


def prefix_features(tokens):
    """One row per causal prefix: token counts followed by the last token."""
    eye = np.eye(V)
    one_hot = eye[tokens]
    return np.concatenate([np.cumsum(one_hot, axis=0), one_hot], axis=1)


def batch(rows, mask_fn):
    features, targets, masks = [], [], []
    for row in rows:
        prompt = encode(row["prompt"])
        tokens = np.concatenate([prompt, encode(row["response"])])
        features.append(prefix_features(tokens[:-1]))
        targets.append(tokens[1:])
        masks.append(mask_fn(tokens, len(prompt)))
    return np.concatenate(features), np.concatenate(targets), np.concatenate(masks)


def hidden(base, features):
    return np.tanh(features @ base["encoder"].T + base["bias"])


def softmax(logits):
    shifted = logits - logits.max(axis=1, keepdims=True)
    exp = np.exp(shifted)
    return exp / exp.sum(axis=1, keepdims=True)


def pretrain(seed=7, steps=1200):
    """Train every base parameter on next-token prediction, including prompts."""
    rng = np.random.default_rng(seed)
    base = {
        "encoder": rng.normal(0, 0.15, (HIDDEN, 2 * V)),
        "bias": np.zeros(HIDDEN),
        "W": rng.normal(0, 0.15, (V, HIDDEN)),
    }
    rows = examples(uppercase=False)
    X, targets, _ = batch(rows, lambda tokens, start: np.ones(len(tokens) - 1))
    for _ in range(steps):
        h = hidden(base, X)
        grad = softmax(h @ base["W"].T)
        grad[np.arange(len(targets)), targets] -= 1
        grad /= len(targets)
        dW = grad.T @ h
        dh = (grad @ base["W"]) * (1 - h * h)
        base["W"] -= 0.5 * dW
        base["encoder"] -= 0.5 * (dh.T @ X)
        base["bias"] -= 0.5 * dh.sum(axis=0)
    return base


def generate(base, W, prompt, max_tokens=3):
    tokens = encode(prompt).tolist()
    response = []
    for _ in range(max_tokens):
        h = hidden(base, prefix_features(np.array(tokens))[-1:])
        next_token = int(np.argmax(h @ W.T))
        response.append(VOCAB[next_token])
        tokens.append(next_token)
        if next_token == TOKEN["<eos>"]:
            break
    return " ".join(response)


def reward_features(prompt, response):
    """Generic token counts and prompt-response token interactions."""
    prompt_counts = np.bincount(encode(prompt), minlength=V)
    response_counts = np.bincount(encode(response), minlength=V)
    return np.concatenate([response_counts, np.outer(prompt_counts, response_counts).ravel()])


def preference_pairs(split="train"):
    """Synthetic preferences: correct uppercase beats lowercase or wrong words."""
    chosen, rejected = [], []
    for row in examples(split):
        word = row["response"].split()[0].lower()
        alternatives = [f"{word} <eos>"] + [
            f"{other.upper()} <eos>" for other in WORDS if other != word
        ]
        for alternative in alternatives:
            chosen.append(reward_features(row["prompt"], row["response"]))
            rejected.append(reward_features(row["prompt"], alternative))
    return np.array(chosen), np.array(rejected)


def train_adapter(model, base, rows=None, steps=600, learning_rate=0.3):
    A, B = model.init_adapter(HIDDEN, V, RANK, seed=11)
    X, targets, mask = batch(examples() if rows is None else rows, model.response_mask)
    history = []
    for _ in range(steps):
        history.append(model.sft_step(base, A, B, X, targets, mask, learning_rate))
    return A, B, history


def train_reward(model, steps=250, learning_rate=0.3):
    chosen, rejected = preference_pairs()
    weights = np.zeros(chosen.shape[1])
    history = [model.reward_step(weights, chosen, rejected, learning_rate) for _ in range(steps)]
    return weights, history


def load_base(path):
    with np.load(Path(path), allow_pickle=False) as checkpoint:
        return {name: checkpoint[name].copy() for name in ("encoder", "bias", "W")}
