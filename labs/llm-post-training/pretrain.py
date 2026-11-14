"""Build a tiny local checkpoint from generated text. No network access."""

import os
from pathlib import Path

os.environ["OPENBLAS_NUM_THREADS"] = "1"

import numpy as np

from tiny_lm import examples, generate, pretrain


def main():
    output = Path(__file__).resolve().parent / "work" / "base.npz"
    output.parent.mkdir(parents=True, exist_ok=True)
    base = pretrain()
    np.savez(output, **base)
    print(f"Trained {sum(value.size for value in base.values())} base parameters on generated text.")
    print(f"Saved {output}")
    for row in examples(uppercase=False)[:4]:
        print(f"{row['prompt']} -> {generate(base, base['W'], row['prompt'])}")


if __name__ == "__main__":
    main()
