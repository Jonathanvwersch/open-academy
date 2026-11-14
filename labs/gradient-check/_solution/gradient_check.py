import numpy as np


def derivative(f, x, eps=1e-5):
    if not np.isfinite(eps) or eps <= 0:
        raise ValueError("eps must be finite and positive")
    return float((f(x + eps) - f(x - eps)) / (2 * eps))


def numerical_gradient(f, point, eps=1e-5):
    point = np.asarray(point, dtype=float)
    if not np.isfinite(eps) or eps <= 0:
        raise ValueError("eps must be finite and positive")
    result = np.zeros_like(point)
    for axis in range(len(point)):
        plus, minus = point.copy(), point.copy()
        plus[axis] += eps
        minus[axis] -= eps
        result[axis] = (f(plus) - f(minus)) / (2 * eps)
    return result


def analytic_gradient(name, point):
    x, y = point
    if name == "bowl":
        return np.array([2 * (x - 1), 4 * (y + 2)])
    if name == "coupled":
        return 2 * (x * y + 1) * np.array([y, x])
    if name == "composed":
        return 4 * (x + 2 * y) ** 3 * np.array([1., 2.])
    raise ValueError("Unknown function name")


def relative_error(analytic, numeric):
    analytic, numeric = np.asarray(analytic), np.asarray(numeric)
    return float(np.linalg.norm(analytic - numeric) /
                 max(1e-12, np.linalg.norm(analytic) + np.linalg.norm(numeric)))


def check_gradient(f, grad, point, eps=1e-5):
    return relative_error(grad(point), numerical_gradient(f, point, eps))


def walk_downhill(f, grad, start, step_size=0.1, steps=80):
    point = np.array(start, dtype=float, copy=True)
    path = [point.copy()]
    values = [float(f(point))]
    for _ in range(steps):
        point -= step_size * grad(point)
        path.append(point.copy())
        values.append(float(f(point)))
    return np.array(path), np.array(values)
