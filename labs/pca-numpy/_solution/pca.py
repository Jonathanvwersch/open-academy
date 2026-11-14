import numpy as np


def centre(X):
    mean = np.mean(X, axis=0)
    return X - mean, mean


def covariance(Xc):
    if len(Xc) < 2:
        raise ValueError("Sample covariance needs at least two rows.")
    return Xc.T @ Xc / (len(Xc) - 1)


def eigen_pca(C):
    values, vectors = np.linalg.eigh(C)
    order = np.argsort(values)[::-1]
    return values[order], vectors[:, order]


def svd_pca(Xc):
    _, singular, Vt = np.linalg.svd(Xc, full_matrices=False)
    return singular ** 2 / (len(Xc) - 1), Vt.T


def direction_agreement(V, W):
    return np.abs(np.sum(V * W, axis=0))


def project(Xc, V, k):
    if not isinstance(k, (int, np.integer)) or not 0 <= k <= V.shape[1]:
        raise ValueError("k must be an integer between zero and the number of directions.")
    return Xc @ V[:, :k]


def reconstruct(Z, V, mean):
    return Z @ V[:, :Z.shape[1]].T + mean


def reconstruction_error(X, reconstructed):
    return float(np.mean((X - reconstructed) ** 2))


def explained_variance(values):
    positive = np.maximum(values, 0)
    total = positive.sum()
    return positive / total if total > 0 else np.zeros_like(positive)
