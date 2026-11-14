import torch


def data(seed=2026):
    """Independent balanced splits of noisy horizontal and vertical bars."""
    device = torch.device("cpu")
    generator = torch.Generator(device=device).manual_seed(seed)
    splits = []
    for count in (96, 400, 400):
        y = (torch.arange(count, device=device) % 2).float()
        x = torch.randn(count, 1, 12, 12, generator=generator, device=device) * 0.5
        positions = torch.randint(2, 9, (count,), generator=generator, device=device)
        for i, position in enumerate(positions):
            if y[i] == 0:
                x[i, 0, position:position + 2, 1:11] += 0.8
            else:
                x[i, 0, 1:11, position:position + 2] += 0.8
        flipped = []
        for label in (0, 1):
            indices = torch.where(y == label)[0]
            flipped.append(indices[torch.randperm(len(indices), generator=generator, device=device)[:count // 16]])
        indices = torch.cat(flipped)
        y[indices] = 1 - y[indices]
        order = torch.randperm(count, generator=generator, device=device)
        splits.append((x[order], y[order]))
    return splits
