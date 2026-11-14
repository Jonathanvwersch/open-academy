import torch
from torch import nn


def normalize(train, validation, test):
    """Return three tensors scaled using the training mean and population std."""
    # TODO: Use one training mean and std for all three splits. Clamp std at 1e-6.
    raise NotImplementedError("Implement normalize")


def build_model(seed):
    torch.manual_seed(seed)
    # TODO: Conv2d(1, 8, 3, padding=1), ReLU, MaxPool2d(2), Flatten,
    # Dropout(0.25), Linear(8 * 6 * 6, 1). Return the Sequential model.
    raise NotImplementedError("Implement build_model")


def train_epoch(model, x, y, optimizer, batch_size, seed):
    order = torch.randperm(len(x), generator=torch.Generator().manual_seed(seed))
    # TODO: Enable training mode. For each group in order.split(batch_size),
    # clear gradients, calculate binary_cross_entropy_with_logits on squeezed
    # model outputs, backpropagate, and update the supplied optimizer.
    raise NotImplementedError("Implement train_epoch")


def evaluate(model, x, y):
    # TODO: This planted bug makes validation depend on dropout masks.
    # Fix the mode and disable gradient recording during evaluation.
    model.train()
    logits = model(x).squeeze(1)
    loss = nn.functional.binary_cross_entropy_with_logits(logits, y)
    accuracy = ((logits >= 0) == y.bool()).float().mean()
    return float(loss.detach()), float(accuracy)


def choose_checkpoint(records):
    """Each record contains train_loss and validation_loss. Return an index."""
    # TODO: Return the index of the smallest validation_loss (first on ties).
    raise NotImplementedError("Implement choose_checkpoint")
