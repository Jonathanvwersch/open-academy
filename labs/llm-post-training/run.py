"""Run the learner's experiment and save inspectable before/after outputs."""

import json
import os
from pathlib import Path
import sys

os.environ["OPENBLAS_NUM_THREADS"] = "1"

import numpy as np

from tiny_lm import examples, generate, load_base, preference_pairs, train_adapter, train_reward


ROOT = Path(__file__).resolve().parent


def main():
    sys.path.insert(0, str(ROOT / "work"))
    import post_training as model

    base = load_base(ROOT / "work" / "base.npz")
    A, B, history = train_adapter(model, base)
    reward_weights, reward_history = train_reward(model)
    samples, outcomes = [], []
    for row in examples("validation"):
        before = generate(base, base["W"], row["prompt"])
        after = generate(base, model.adapted_weight(base["W"], A, B), row["prompt"])
        base_correct = int(before == row["response"])
        adapted_correct = int(after == row["response"])
        outcomes.append(adapted_correct - base_correct)
        samples.append({**row, "base": before, "adapted": after})
    chosen, rejected = preference_pairs("validation")
    result = {
        "samples": samples,
        "base_exact_match": float(np.mean([row["base"] == row["response"] for row in samples])),
        "adapted_exact_match": float(np.mean([row["adapted"] == row["response"] for row in samples])),
        "wins": outcomes.count(1),
        "ties": outcomes.count(0),
        "losses": outcomes.count(-1),
        "tie_adjusted_win_rate": model.win_rate(np.array(outcomes)),
        "reward_pair_accuracy": float(np.mean(chosen @ reward_weights > rejected @ reward_weights)),
        "sft_initial_loss": history[0],
        "sft_final_loss": history[-1],
        "reward_initial_loss": reward_history[0],
        "reward_final_loss": reward_history[-1],
    }
    np.savez(ROOT / "work" / "adapter.npz", A=A, B=B)
    np.savez(ROOT / "work" / "reward.npz", weights=reward_weights)
    output = ROOT / "work" / "experiment.json"
    output.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))
    print(f"Saved {output}")


if __name__ == "__main__":
    main()
