"""Write a portable grayscale image grid using only NumPy."""
from pathlib import Path
import importlib.util
import numpy as np
from data import make_images

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("learner", ROOT / "work" / "pca.py")
model = importlib.util.module_from_spec(spec)
spec.loader.exec_module(model)
X = make_images()
Xc, mean = model.centre(X)
values, V = model.eigen_pca(model.covariance(Xc))
rows = [X[:8].reshape(8, 8, 8)]
for k in (0, 1, 2, 3, 8):
    copy = model.reconstruct(model.project(Xc, V, k), V, mean)
    rows.append(copy[:8].reshape(8, 8, 8))
    print(f"k={k}: error={model.reconstruction_error(X, copy):.6f}, retained={model.explained_variance(values)[:k].sum():.6f}")
grid = np.concatenate([np.concatenate(list(row), axis=1) for row in rows], axis=0)
pixels = (np.clip(grid, 0, 1) * 255).astype(np.uint8)
output = ROOT / "work" / "reconstructions.pgm"
output.write_bytes(f"P5\n{grid.shape[1]} {grid.shape[0]}\n255\n".encode() + pixels.tobytes())
print(f"Saved {output}. Rows: originals, then k=0, 1, 2, 3, 8.")
