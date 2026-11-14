"""Small CPU decoder. Implement the TODO functions in work/model.py."""
from pathlib import Path

import torch
from torch import nn
from torch.nn import functional as F


CONTEXT = 32


def vocabulary(text):
    # TODO: Return a sorted list of unique characters.
    raise NotImplementedError("vocabulary")


def encode(text, chars):
    # TODO: Map each character to its index in chars. Unknown characters raise ValueError.
    raise NotImplementedError("encode")


def decode(ids, chars):
    # TODO: Join the characters selected by ids, including the empty list.
    raise NotImplementedError("decode")


def attention(q, k, v):
    # TODO: Compute scaled query-key scores, mask future columns before softmax, then mix values. Return (output, weights).
    raise NotImplementedError("attention")


def split_heads(x, heads):
    # TODO: Reshape (B,T,C) to (B,H,T,C/H), preserving each head's contiguous feature slice.
    raise NotImplementedError("split_heads")


def merge_heads(x):
    # TODO: Reverse split_heads, preserving time and feature order.
    raise NotImplementedError("merge_heads")


def embed(ids, tokens, positions):
    # TODO: Add token lookups and learned position lookups for positions 0 through T-1.
    raise NotImplementedError("embed")


def block_forward(x, norm1, attn, norm2, mlp):
    # TODO: Apply pre-norm attention with a residual, then pre-norm MLP with a residual.
    raise NotImplementedError("block_forward")


def sample_next(logits, temperature, generator):
    # TODO: Reject nonpositive temperature. Scale logits, softmax, and draw one id per row with the supplied generator.
    raise NotImplementedError("sample_next")


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


def train(seed=7, steps=250):
    torch.set_num_threads(1)
    torch.manual_seed(seed)
    text = (Path(__file__).resolve().parents[1] / "text.txt").read_text(encoding="utf-8")
    chars = vocabulary(text)
    data = torch.tensor(encode(text, chars), dtype=torch.long)
    model = Decoder(len(chars))
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.003, weight_decay=0.01)
    batches = torch.Generator().manual_seed(seed + 1000)
    starts = torch.arange(16) * CONTEXT
    fixed_x = torch.stack([data[start:start + CONTEXT] for start in starts])
    fixed_y = torch.stack([data[start + 1:start + CONTEXT + 1] for start in starts])

    def evaluate():
        with torch.no_grad():
            return F.cross_entropy(model(fixed_x).reshape(-1, len(chars)), fixed_y.reshape(-1)).item()

    initial = evaluate()
    for _ in range(steps):
        starts = torch.randint(len(data) - CONTEXT, (16,), generator=batches)
        x = torch.stack([data[start:start + CONTEXT] for start in starts])
        y = torch.stack([data[start + 1:start + CONTEXT + 1] for start in starts])
        loss = F.cross_entropy(model(x).reshape(-1, len(chars)), y.reshape(-1))
        optimizer.zero_grad()
        loss.backward()
        optimizer.step()
    return model, chars, initial, evaluate()
