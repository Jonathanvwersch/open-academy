"""Fixed-seed 8 by 8 shapes. No files or downloads are needed."""
import numpy as np


def make_images(seed=17, n=160):
    rng = np.random.default_rng(seed)
    shapes = np.zeros((3, 8, 8))
    shapes[0, :, 2:4] = 1
    shapes[1, 4:6, :] = 1
    np.fill_diagonal(shapes[2], 1)
    weights = rng.normal(size=(n, 3)) * np.array([0.22, 0.12, 0.06])
    return 0.5 + weights @ shapes.reshape(3, 64) + rng.normal(0, 0.01, (n, 64))
