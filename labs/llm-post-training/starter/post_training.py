"""Fill in the post-training ideas. The model and training loops are provided."""

from pathlib import Path
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tiny_lm import hidden, softmax


def response_mask(tokens, response_start):
    """Return len(tokens)-1 entries, aligned with targets tokens[1:]."""
    # TODO: Select targets whose original token index is >= response_start.
    raise NotImplementedError("TODO: align the response mask with next-token targets.")


def init_adapter(n_in, n_out, rank, seed):
    """Return A (rank, n_in) and B (n_out, rank)."""
    # TODO: Draw A with default_rng(seed).normal(0, 0.1, (rank, n_in)); zero B.
    raise NotImplementedError("TODO: initialize the two thin LoRA matrices.")


def adapted_weight(W, A, B):
    # TODO: Return the effective output matrix, keeping W unchanged.
    raise NotImplementedError("TODO: add the low-rank change to W.")


def masked_loss(logits, targets, mask):
    """Return mean response loss and its gradient against every logit."""
    # TODO: Use shifted logits for stable log probabilities. Reject an empty mask.
    # TODO: Average over selected targets. Mask and normalize the gradient too.
    raise NotImplementedError("TODO: compute response-only cross-entropy and gradients.")


def sft_step(base, A, B, X, targets, mask, learning_rate):
    """Update A and B in place. Return loss before this update."""
    # TODO: Use hidden(base, X), adapted_weight and masked_loss for the forward pass.
    # TODO: Backpropagate to A and B. Calculate both gradients before either update.
    # Keep every array in base unchanged.
    raise NotImplementedError("TODO: take one supervised LoRA update.")


def preference_loss(chosen_scores, rejected_scores):
    """Return mean Bradley-Terry loss, chosen gradients, rejected gradients."""
    # TODO: Use chosen minus rejected. np.logaddexp keeps the loss stable.
    # TODO: Differentiate the mean loss with respect to both score arrays.
    raise NotImplementedError("TODO: score the chosen response above the rejected one.")


def reward_step(weights, chosen, rejected, learning_rate):
    """Update linear reward weights in place. Return loss before the update."""
    # TODO: Score both feature batches, call preference_loss, and update weights.
    raise NotImplementedError("TODO: train the reward model on preference pairs.")


def win_rate(outcomes):
    """Outcomes: 1 = adapted wins, 0 = tie, -1 = base wins."""
    # TODO: Give each tie half credit. Reject an empty set of comparisons.
    raise NotImplementedError("TODO: include ties and losses in the win-rate denominator.")
