"""Small CPU decoder. Implement the TODO functions in work/model.py."""
from pathlib import Path

import torch
from torch import nn
from torch.nn import functional as F


CONTEXT = 32


def vocabulary(text):
    return sorted(set(text))


def encode(text, chars):
    return [chars.index(char) for char in text]


def decode(ids, chars):
    return "".join(chars[index] for index in ids)


def attention(q, k, v):
    scores = q @ k.transpose(-2, -1) / q.shape[-1] ** 0.5
    future = torch.ones(scores.shape[-2:], dtype=torch.bool, device=q.device).triu(1)
    weights = scores.masked_fill(future, float("-inf")).softmax(dim=-1)
    return weights @ v, weights


def split_heads(x, heads):
    batch, time, width = x.shape
    return x.reshape(batch, time, heads, width // heads).transpose(1, 2)


def merge_heads(x):
    batch, heads, time, size = x.shape
    return x.transpose(1, 2).contiguous().reshape(batch, time, heads * size)


def embed(ids, tokens, positions):
    return tokens(ids) + positions(torch.arange(ids.shape[1], device=ids.device))


def block_forward(x, norm1, attn, norm2, mlp):
    x = x + attn(norm1(x))
    return x + mlp(norm2(x))


def sample_next(logits, temperature, generator):
    if temperature <= 0:
        raise ValueError("temperature must be positive")
    probabilities = (logits / temperature).softmax(dim=-1)
    return torch.multinomial(probabilities, 1, generator=generator)


class MultiHead(nn.Module):
    def __init__(self, width=32, heads=4):
        super().__init__()
        self.heads = heads
        self.qkv = nn.Linear(width, 3 * width)
        self.output = nn.Linear(width, width)

    def forward(self, x):
        q, k, v = [split_heads(part, self.heads) for part in self.qkv(x).chunk(3, dim=-1)]
        mixed, _ = attention(q, k, v)
        return self.output(merge_heads(mixed))


class Block(nn.Module):
    def __init__(self, width=32):
        super().__init__()
        self.norm1 = nn.LayerNorm(width)
        self.attn = MultiHead(width)
        self.norm2 = nn.LayerNorm(width)
        self.mlp = nn.Sequential(nn.Linear(width, 4 * width), nn.ReLU(), nn.Linear(4 * width, width))

    def forward(self, x):
        return block_forward(x, self.norm1, self.attn, self.norm2, self.mlp)


class Decoder(nn.Module):
    def __init__(self, vocab_size):
        super().__init__()
        self.tokens = nn.Embedding(vocab_size, 32)
        self.positions = nn.Embedding(CONTEXT, 32)
        self.block = Block()
        self.norm = nn.LayerNorm(32)
        self.readout = nn.Linear(32, vocab_size)
        self.apply(self.initialize)

    @staticmethod
    def initialize(module):
        if isinstance(module, (nn.Linear, nn.Embedding)):
            nn.init.normal_(module.weight, mean=0.0, std=0.02)
            if isinstance(module, nn.Linear):
                nn.init.zeros_(module.bias)

    def forward(self, ids):
        if ids.ndim != 2 or not 1 <= ids.shape[1] <= CONTEXT:
            raise ValueError("ids must have shape (batch, time), with time from 1 to 32")
        return self.readout(self.norm(self.block(embed(ids, self.tokens, self.positions))))


@torch.no_grad()
def generate(model, prompt, count, seed=7, temperature=1.0):
    generator = torch.Generator().manual_seed(seed)
    ids = prompt.clone()
    for _ in range(count):
        logits = model(ids[:, -CONTEXT:])[:, -1, :]
        ids = torch.cat((ids, sample_next(logits, temperature, generator)), dim=1)
    return ids


def split_data(data):
    boundary = int(0.9 * len(data))
    return data[:boundary], data[boundary:]


@torch.no_grad()
def fixed_loss(model, data, vocab_size):
    if len(data) <= CONTEXT:
        raise ValueError("evaluation needs at least 33 characters")
    starts = torch.arange(0, len(data) - CONTEXT, CONTEXT)
    x = torch.stack([data[start:start + CONTEXT] for start in starts])
    y = torch.stack([data[start + 1:start + CONTEXT + 1] for start in starts])
    return F.cross_entropy(model(x).reshape(-1, vocab_size), y.reshape(-1)).item()


def train(seed=7, steps=250):
    torch.set_num_threads(1)
    torch.manual_seed(seed)
    text = (Path(__file__).resolve().parents[1] / "text.txt").read_text(encoding="utf-8")
    chars = vocabulary(text)
    data, validation = split_data(torch.tensor(encode(text, chars), dtype=torch.long))
    model = Decoder(len(chars))
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.003, weight_decay=0.01)
    batches = torch.Generator().manual_seed(seed + 1000)
    evaluation_data = data[:16 * CONTEXT + 1]
    initial = fixed_loss(model, evaluation_data, len(chars))
    for _ in range(steps):
        starts = torch.randint(len(data) - CONTEXT, (16,), generator=batches)
        x = torch.stack([data[start:start + CONTEXT] for start in starts])
        y = torch.stack([data[start + 1:start + CONTEXT + 1] for start in starts])
        loss = F.cross_entropy(model(x).reshape(-1, len(chars)), y.reshape(-1))
        optimizer.zero_grad()
        loss.backward()
        optimizer.step()
    final = fixed_loss(model, evaluation_data, len(chars))
    val_loss = fixed_loss(model, validation, len(chars))
    return model, chars, initial, final, val_loss
