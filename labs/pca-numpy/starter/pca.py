"""Implement PCA for examples stored as rows. See the project milestones."""
import numpy as np


def centre(X):
    """Return (centred data, feature mean). X has shape (n, d)."""
    # TODO: subtract each column's mean.
    raise NotImplementedError("Compute the feature mean and subtract it.")


def covariance(Xc):
    """Return the sample covariance of already centred rows; require n >= 2."""
    # TODO: form the matrix product and divide by n - 1.
    raise NotImplementedError("Compute sample covariance.")


def eigen_pca(C):
    """Return (values, vectors) sorted largest first; vectors are columns."""
    # TODO: call eigh and reorder both outputs together.
    raise NotImplementedError("Sort eigenvalues and eigenvector columns.")


def svd_pca(Xc):
    """Return (covariance eigenvalues, right singular vectors as columns)."""
    # TODO: use reduced SVD; relate squared singular values to covariance.
    raise NotImplementedError("Compare PCA with the SVD.")


def direction_agreement(V, W):
    """Return absolute dot products of corresponding unit-vector columns."""
    # TODO: compare directions while allowing either sign.
    raise NotImplementedError("Handle eigenvector sign ambiguity.")


def project(Xc, V, k):
    """Return (n, k) coordinates; allow k from zero to V.shape[1]."""
    # TODO: use the leading k eigenvector columns.
    raise NotImplementedError("Project onto the retained directions.")


def reconstruct(Z, V, mean):
    """Return reconstructed rows in the original feature coordinates."""
    # TODO: map back with the retained columns and restore the mean.
    raise NotImplementedError("Reconstruct from the coordinates.")


def reconstruction_error(X, reconstructed):
    """Return average squared error per matrix entry."""
    # TODO: square differences and average all entries.
    raise NotImplementedError("Measure reconstruction error.")


def explained_variance(values):
    """Return each eigenvalue's fraction of total variance; zeros if total is zero."""
    # TODO: handle tiny negative roundoff and the all-zero spectrum.
    raise NotImplementedError("Calculate explained variance fractions.")
