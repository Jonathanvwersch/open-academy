import torch
from torch import nn


def normalize(train, validation, test):
    mean = train.mean()
    std = train.std(unbiased=False).clamp_min(1e-6)
    return tuple((x - mean) / std for x in (train, validation, test))


def build_model(seed):
    torch.manual_seed(seed)
    return nn.Sequential(
        nn.Conv2d(1, 8, 3, padding=1), nn.ReLU(), nn.MaxPool2d(2),
        nn.Flatten(), nn.Dropout(0.25), nn.Linear(8 * 6 * 6, 1),
    )


def train_epoch(model, x, y, optimizer, batch_size, seed):
    model.train()
    if len(x) == 0:
        return
    order = torch.randperm(len(x), generator=torch.Generator().manual_seed(seed))
    for indices in order.split(batch_size):
        optimizer.zero_grad()
        logits = model(x[indices]).squeeze(1)
        loss = nn.functional.binary_cross_entropy_with_logits(logits, y[indices])
        loss.backward()
        optimizer.step()


def evaluate(model, x, y):
    model.eval()
    with torch.no_grad():
        logits = model(x).squeeze(1)
        loss = nn.functional.binary_cross_entropy_with_logits(logits, y)
        accuracy = ((logits >= 0) == y.bool()).float().mean()
    return float(loss), float(accuracy)


def choose_checkpoint(records):
    return min(range(len(records)), key=lambda i: records[i]["validation_loss"])
