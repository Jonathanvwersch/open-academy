import torch


def data(seed=2026):
    """Independent balanced splits of noisy horizontal and vertical bars."""
    generator = torch.Generator().manual_seed(seed)
    splits = []
    for count in (240, 80, 80):
        y = (torch.arange(count) % 2).float()
        x = torch.rand(count, 1, 12, 12, generator=generator) * 0.25
        positions = torch.randint(2, 9, (count,), generator=generator)
        for i, position in enumerate(positions):
            if y[i] == 0:
                x[i, 0, position:position + 2, 1:11] += 0.7
            else:
                x[i, 0, 1:11, position:position + 2] += 0.7
        order = torch.randperm(count, generator=generator)
        splits.append((x[order], y[order]))
    return splits
