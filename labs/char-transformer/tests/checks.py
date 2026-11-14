"""Public concept checks. Each check runs independently so TODOs stay actionable."""
import math
from pathlib import Path

import torch
from torch import nn
from torch.nn import functional as F


def run_checks(m):
    torch.set_num_threads(1)
    checks, metrics = [], {}

    def check(identifier, hint, function):
        try:
            torch.manual_seed(29)
            function()
            checks.append({"id": identifier, "passed": True, "message": hint})
        except Exception as error:
            checks.append({"id": identifier, "passed": False,
                           "message": f"{hint} {type(error).__name__}: {error}"})

    def tokenizer():
        chars = m.vocabulary("cabac\n")
        assert chars == ["\n", "a", "b", "c"], "Sort the unique characters."
        assert m.encode("cab", chars) == [3, 1, 2]
        assert m.decode([3, 1, 2], chars) == "cab"
        assert m.vocabulary("") == [] and m.encode("", chars) == [] and m.decode([], chars) == ""
        try:
            m.encode("?", chars)
        except ValueError:
            return
        raise AssertionError("An unknown character must raise ValueError.")

    def attention_values():
        q, k, v = [torch.randn(2, 3, 5, 4) for _ in range(3)]
        out, weights = m.attention(q, k, v)
        scores = q @ k.transpose(-2, -1) / 2
        scores = scores.masked_fill(torch.ones(5, 5, dtype=torch.bool).triu(1), float("-inf"))
        expected = scores.softmax(-1)
        assert out.shape == (2, 3, 5, 4) and weights.shape == (2, 3, 5, 5)
        torch.testing.assert_close(weights, expected)
        torch.testing.assert_close(out, expected @ v)
        out, weights = m.attention(q[..., :1, :], k[..., :1, :], v[..., :1, :])
        torch.testing.assert_close(out, v[..., :1, :])
        assert torch.isfinite(weights).all()

    def causal():
        q, k, v = [torch.randn(1, 2, 5, 4) for _ in range(3)]
        out, weights = m.attention(q, k, v)
        assert torch.count_nonzero(weights.triu(1)) == 0, "Future weights must be exactly zero."
        torch.testing.assert_close(weights.sum(-1), torch.ones(1, 2, 5))
        k[..., 3:, :] += 50
        v[..., 3:, :] -= 50
        changed, _ = m.attention(q, k, v)
        torch.testing.assert_close(out[..., :3, :], changed[..., :3, :])

    def heads():
        x = torch.arange(2 * 5 * 12).reshape(2, 5, 12)
        split = m.split_heads(x, 3)
        assert split.shape == (2, 3, 5, 4)
        for head in range(3):
            assert torch.equal(split[:, head], x[:, :, head * 4:(head + 1) * 4])
        assert torch.equal(m.merge_heads(split), x)
        assert m.split_heads(x[:, :1], 1).shape == (2, 1, 1, 12)

    def positions():
        tokens, positions = nn.Embedding(7, 4), nn.Embedding(32, 4)
        ids = torch.tensor([[2, 2, 2], [1, 2, 3]])
        actual = m.embed(ids, tokens, positions)
        expected = tokens(ids) + positions(torch.arange(3))
        torch.testing.assert_close(actual, expected)
        assert not torch.equal(actual[0, 0], actual[0, 1])
        actual.sum().backward()
        assert tokens.weight.grad.abs().sum() > 0 and positions.weight.grad.abs().sum() > 0

    def block():
        x = torch.randn(2, 5, 8, requires_grad=True)
        n1, n2 = nn.LayerNorm(8), nn.LayerNorm(8)
        a, f = nn.Linear(8, 8), nn.Sequential(nn.Linear(8, 16), nn.ReLU(), nn.Linear(16, 8))
        first = x + a(n1(x))
        expected = first + f(n2(first))
        actual = m.block_forward(x, n1, a, n2, f)
        torch.testing.assert_close(actual, expected)
        actual.square().mean().backward()
        assert x.grad is not None and a.weight.grad.abs().sum() > 0

    def decoder():
        model = m.Decoder(11)
        ids = torch.randint(11, (2, 8))
        logits = model(ids)
        assert logits.shape == (2, 8, 11) and torch.isfinite(logits).all()
        altered = ids.clone()
        altered[:, 4:] = (altered[:, 4:] + 1) % 11
        torch.testing.assert_close(logits[:, :4], model(altered)[:, :4])
        F.cross_entropy(logits.reshape(-1, 11), ids.reshape(-1)).backward()
        for parameter in model.parameters():
            assert parameter.grad is not None and torch.isfinite(parameter.grad).all()
        for length in [0, 33]:
            try:
                model(torch.zeros(1, length, dtype=torch.long))
            except ValueError:
                continue
            raise AssertionError("Reject context lengths outside 1..32.")

    def training():
        numbered = torch.arange(100)
        train_data, val_data = m.split_data(numbered)
        assert torch.equal(train_data, numbered[:90]) and torch.equal(val_data, numbered[90:]), (
            "Train on the first 90% of characters and hold out the final 10%."
        )
        empty_train, empty_val = m.split_data(torch.tensor([]))
        assert empty_train.numel() == 0 and empty_val.numel() == 0
        network, chars, initial, final, val_loss = m.train(seed=7)
        assert all(parameter.device.type == "cpu" for parameter in network.parameters())
        text = (Path(__file__).resolve().parents[1] / "text.txt").read_text(encoding="utf-8")
        data = torch.tensor(m.encode(text, chars), dtype=torch.long)
        held_out = data[int(0.9 * len(data)):]
        starts = range(0, len(held_out) - m.CONTEXT, m.CONTEXT)
        x = torch.stack([held_out[start:start + m.CONTEXT] for start in starts])
        y = torch.stack([held_out[start + 1:start + m.CONTEXT + 1] for start in starts])
        with torch.no_grad():
            expected = F.cross_entropy(network(x).reshape(-1, len(chars)), y.reshape(-1)).item()
        assert abs(val_loss - expected) < 1e-6, "Report loss on fixed held-out windows."
        assert m.fixed_loss(network, held_out, len(chars)) == val_loss
        for length in [0, m.CONTEXT]:
            try:
                m.fixed_loss(network, data[:length], len(chars))
            except ValueError:
                continue
            raise AssertionError("Reject evaluation text shorter than one input-target window.")
        assert math.isfinite(initial) and initial > 0 and math.isfinite(final) and math.isfinite(val_loss), (
            "Loss must be finite. Check that the mask keeps the diagonal and softmax has an allowed key."
        )
        metrics.update(final_loss=final, loss_ratio=final / initial, val_loss=val_loss)
        assert final < 2.1, f"Final fixed-batch loss {final:.4f} must be below 2.1."
        assert final / initial < 0.7, "Loss must fall by more than 30%."
        assert val_loss < 1.8, f"Held-out loss {val_loss:.4f} must be below 1.8."

    def sampling():
        logits = torch.tensor([[1.0, -1.0, 0.0]]).repeat(64, 1)
        generator = torch.Generator().manual_seed(23)
        expected = torch.multinomial((logits / 0.5).softmax(-1), 1,
                                     generator=torch.Generator().manual_seed(23))
        actual = m.sample_next(logits, 0.5, generator)
        assert torch.equal(actual, expected), "Use multinomial with temperature and the supplied RNG."
        for temperature in [0, -1]:
            try:
                m.sample_next(logits, temperature, generator)
            except ValueError:
                continue
            raise AssertionError("Reject nonpositive temperature.")
        model = m.Decoder(9)
        prompt = torch.tensor([[1, 2, 3]])
        first = m.generate(model, prompt, 40, seed=3)
        assert first.shape == (1, 43) and first.dtype == torch.long
        assert torch.equal(first[:, :3], prompt) and first.min() >= 0 and first.max() < 9
        assert torch.equal(first, m.generate(model, prompt, 40, seed=3))
        assert torch.equal(prompt, m.generate(model, prompt, 0))

    for identifier, hint, function in [
        ("test_tokenization", "Round-trip sorted character IDs, empty text, and unknown characters.", tokenizer),
        ("test_attention_values", "Scale scores, softmax over keys, and multiply by values.", attention_values),
        ("test_causal_mask", "Mask future scores before softmax; keep the diagonal and row sums of one.", causal),
        ("test_head_split_merge", "Keep each head's feature slice and reverse the transpose when merging.", heads),
        ("test_position_add", "Add learned positions to token embeddings and preserve gradients.", positions),
        ("test_block_residuals", "Use two pre-norm residual updates, with the second using the updated state.", block),
        ("test_decoder_shapes", "Return (batch,time,vocabulary) logits with causal outputs and finite gradients.", decoder),
        ("test_training_loss", "Train for 250 CPU steps using the supplied initialization and seeds.", training),
        ("test_sampling", "Sample reproducibly with temperature, preserve the prompt, and crop context.", sampling),
    ]:
        check(identifier, hint, function)
    return checks, metrics
