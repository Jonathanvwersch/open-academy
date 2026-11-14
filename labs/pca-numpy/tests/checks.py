"""Independent public checks. Each failure remains uploadable to the app."""
import numpy as np


def run_checks(model, make_images):
    checks = []
    metrics = {}
    X = np.array([[2., 1., 4.], [4., 5., 3.], [6., 3., 8.], [8., 7., 5.]])
    mean = X.mean(axis=0)
    Xc = X - mean
    C = Xc.T @ Xc / 3
    values, V = np.linalg.eigh(C)
    values, V = values[::-1], V[:, ::-1]

    def check(name, message, run):
        try:
            assert run(), message
            checks.append({"id": name, "passed": True, "message": "Passed. " + message})
        except Exception as error:
            checks.append({"id": name, "passed": False,
                           "message": f"{message} ({type(error).__name__}: {error})"})

    def centring():
        actual, mu = model.centre(X)
        constant, _ = model.centre(np.ones((3, 2)) * 7)
        return np.allclose(actual, Xc) and np.allclose(mu, mean) and np.allclose(constant, 0)

    def cov():
        correct = np.allclose(model.covariance(Xc), C)
        try:
            model.covariance(np.ones((1, 3)))
        except ValueError:
            return correct
        return False

    def eigen():
        actual, directions = model.eigen_pca(C)
        return (np.allclose(actual, values) and np.allclose(directions.T @ directions, np.eye(3))
                and np.allclose(C @ directions, directions * actual)
                and np.allclose(np.abs(np.sum(directions * V, axis=0)), 1))

    def svd():
        actual, directions = model.svd_pca(Xc)
        agreement = model.direction_agreement(V, directions)
        flipped = model.direction_agreement(V, -V)
        rotated = model.direction_agreement(np.eye(3), np.eye(3)[:, ::-1])
        return (np.allclose(actual, values) and np.allclose(agreement, 1)
                and np.allclose(np.abs(np.sum(V * directions, axis=0)), 1)
                and np.allclose(flipped, 1) and np.allclose(rotated, [0, 1, 0]))

    def projection():
        correct = all(np.allclose(model.project(Xc, V, k), Xc @ V[:, :k]) for k in (0, 1, 3))
        for k in (-1, 4, 1.5):
            try:
                model.project(Xc, V, k)
            except ValueError:
                continue
            return False
        return correct

    def reconstruction():
        Z = Xc @ V[:, :2]
        return (np.allclose(model.reconstruct(Z, V, mean), Z @ V[:, :2].T + mean)
                and np.allclose(model.reconstruct(np.empty((4, 0)), V, mean), np.tile(mean, (4, 1)))
                and np.allclose(model.reconstruct(Xc @ V, V, mean), X))

    def error():
        return (np.isclose(model.reconstruction_error(X, X + 2), 4)
                and np.isclose(model.reconstruction_error(X, X), 0))

    def variance():
        return (np.allclose(model.explained_variance(np.array([6., 3., 1.])), [.6, .3, .1])
                and np.allclose(model.explained_variance(np.zeros(3)), 0)
                and np.allclose(model.explained_variance(np.array([2., -1e-14])), [1, 0]))

    check("test_centre", "Subtract column means; constant images must become zero.", centring)
    check("test_covariance", "Use Xc.T @ Xc divided by n - 1; reject fewer than two rows.", cov)
    check("test_eigen_sorted", "Sort eigenvalues descending and reorder eigenvector columns together.", eigen)
    check("test_svd_sign_invariant", "Compare squared singular values divided by n - 1 and absolute column dot products.", svd)
    check("test_projection", "Multiply by the leading k columns; allow k=0 and reject invalid k.", projection)
    check("test_reconstruction", "Multiply coordinates by retained columns transposed and add the feature mean.", reconstruction)
    check("test_error", "Average squared differences over every entry; identical inputs give zero.", error)
    check("test_explained_variance", "Divide nonnegative eigenvalues by their total; a zero spectrum gives zeros.", variance)

    def images():
        data = make_images()
        centred, mu = model.centre(data)
        spectrum, directions = model.eigen_pca(model.covariance(centred))
        errors = []
        for k in (0, 1, 2, 3, 8, 64):
            rebuilt = model.reconstruct(model.project(centred, directions, k), directions, mu)
            errors.append(model.reconstruction_error(data, rebuilt))
        retained = float(model.explained_variance(spectrum)[:3].sum())
        metrics.update(reconstruction_error_k3=float(errors[3]), explained_variance_k3=retained)
        return (np.isfinite(errors).all() and np.isfinite(retained)
                and np.all(np.diff(errors) <= 1e-12) and errors[-1] < 1e-20
                and errors[3] < 0.0002 and retained > 0.98)

    check("test_image_compression", "Image errors must decrease through k=0,1,2,3,8,64; k=3 error <0.0002 and retained variance >0.98.", images)
    metrics = {key: value for key, value in metrics.items() if np.isfinite(value)}
    return checks, metrics
