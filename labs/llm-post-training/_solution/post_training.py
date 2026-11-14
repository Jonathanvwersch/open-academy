"""Reference implementation for the post-training lab."""

from pathlib import Path
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tiny_lm import hidden, softmax


def response_mask(tokens, response_start):
    return (np.arange(1, len(tokens)) >= response_start).astype(float)


def init_adapter(n_in, n_out, rank, seed):
    rng = np.random.default_rng(seed)
    return rng.normal(0, 0.1, (rank, n_in)), np.zeros((n_out, rank))


def adapted_weight(W, A, B):
    return W + B @ A


def masked_loss(logits, targets, mask):
    if mask.sum() == 0:
        raise ValueError("Select at least one response target.")
    shifted = logits - logits.max(axis=1, keepdims=True)
    log_probs = shifted - np.log(np.exp(shifted).sum(axis=1, keepdims=True))
    loss = -np.sum(log_probs[np.arange(len(targets)), targets] * mask) / mask.sum()
    grad = softmax(logits)
    grad[np.arange(len(targets)), targets] -= 1
    grad *= mask[:, None] / mask.sum()
    return float(loss), grad


def sft_step(base, A, B, X, targets, mask, learning_rate):
    h = hidden(base, X)
    loss, grad = masked_loss(h @ adapted_weight(base["W"], A, B).T, targets, mask)
    dW = grad.T @ h
    dA = B.T @ dW
    dB = dW @ A.T
    A -= learning_rate * dA
    B -= learning_rate * dB
    return loss


def preference_loss(chosen_scores, rejected_scores):
    difference = chosen_scores - rejected_scores
    loss = np.logaddexp(0, -difference).mean()
    probability = np.exp(-np.logaddexp(0, -difference))
    chosen_grad = (probability - 1) / len(difference)
    return float(loss), chosen_grad, -chosen_grad


def reward_step(weights, chosen, rejected, learning_rate):
    loss, chosen_grad, rejected_grad = preference_loss(chosen @ weights, rejected @ weights)
    grad = chosen.T @ chosen_grad + rejected.T @ rejected_grad
    weights -= learning_rate * grad
    return loss


def win_rate(outcomes):
    if len(outcomes) == 0:
        raise ValueError("Need at least one comparison.")
    return float((np.sum(outcomes == 1) + 0.5 * np.sum(outcomes == 0)) / len(outcomes))
