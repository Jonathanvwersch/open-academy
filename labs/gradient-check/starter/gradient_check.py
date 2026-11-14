import numpy as np


def derivative(f, x, eps=1e-5):
    """Return a scalar central difference. Reject nonpositive or nonfinite eps."""
    # TODO: Evaluate f on both sides of x and divide by the full interval.
    raise NotImplementedError("Implement the central-difference derivative.")


def numerical_gradient(f, point, eps=1e-5):
    """Return one partial per coordinate without changing point. Allow empty vectors."""
    # TODO: Copy point for each coordinate and change only that coordinate.
    # TODO: Reject nonpositive or nonfinite eps with ValueError.
    raise NotImplementedError("Implement coordinate-wise central differences.")


def analytic_gradient(name, point):
    """Return the hand-derived gradient for bowl, coupled, or composed."""
    # TODO: Derive the three gradients on paper, then implement them.
    # TODO: Raise ValueError for an unknown name.
    raise NotImplementedError("Implement the analytic gradients.")


def relative_error(analytic, numeric):
    """Return ||analytic-numeric|| / max(1e-12, ||analytic||+||numeric||)."""
    # TODO: Use np.linalg.norm. Two empty vectors have error zero.
    raise NotImplementedError("Implement relative error.")


def check_gradient(f, grad, point, eps=1e-5):
    """Return the relative error between analytic and numerical gradients."""
    # TODO: Connect your numerical_gradient and relative_error functions.
    raise NotImplementedError("Implement the gradient checker.")


def walk_downhill(f, grad, start, step_size=0.1, steps=80):
    """Return (path, values), including the start and every updated point."""
    # TODO: Subtract step_size * grad(point) repeatedly. Save independent copies.
    # TODO: Keep start unchanged. With zero steps, return only the start.
    raise NotImplementedError("Implement the downhill walk.")
