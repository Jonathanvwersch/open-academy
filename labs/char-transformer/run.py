import argparse
import importlib.util
from pathlib import Path
import time

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description="Train on CPU and print a sample.")
    parser.add_argument("--implementation", type=Path, default=ROOT / "work" / "model.py")
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location("candidate", args.implementation.resolve())
    model = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(model)
    start = time.perf_counter()
    network, chars, initial, final = model.train(seed=args.seed)
    print(f"Fixed-batch loss: {initial:.4f} -> {final:.4f}")
    print(f"Training seconds: {time.perf_counter() - start:.3f}")
    prompt = model.torch.tensor([model.encode("the ", chars)])
    ids = model.generate(network, prompt, 200, seed=args.seed, temperature=0.8)
    print(model.decode(ids[0].tolist(), chars))


if __name__ == "__main__":
    main()
