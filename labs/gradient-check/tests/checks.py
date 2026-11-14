"""Public deterministic checks for the gradient checker."""

import numpy as np


FUNCTIONS = {
    "bowl": lambda p: (p[0] - 1) ** 2 + 2 * (p[1] + 2) ** 2,
    "coupled": lambda p: (p[0] * p[1] + 1) ** 2,
    "composed": lambda p: (p[0] + 2 * p[1]) ** 4,
}


def run_checks(model):
    checks, metrics = [], {}

    def check(identifier, action, message):
        try:
            action()
            checks.append({"id": identifier, "passed": True, "message": message})
        except Exception as error:
            checks.append({
                "id": identifier, "passed": False,
                "message": f"{message} {type(error).__name__}: {error}",
            })

    def derivative():
        for x in [-2., 0., 1.5]:
            assert np.isclose(model.derivative(lambda t: t ** 3 - 2 * t, x),
                              3 * x ** 2 - 2, atol=1e-7)
        assert np.isclose(model.derivative(lambda t: t ** 3, 2., 0.1), 12.01)
        assert abs(model.derivative(lambda t: 7., 1.)) < 1e-10

    def partials():
        point = np.array([1., 2., -3.])
        original = point.copy()
        actual = model.numerical_gradient(lambda p: p[0] * p[1] + p[2] ** 2, point)
        assert actual.shape == point.shape
        assert np.allclose(actual, [2., 1., -6.], atol=1e-7)
        assert np.array_equal(point, original), "The input point was changed."

    def analytic():
        for point in [np.array([1., 2.]), np.array([-2., 0.5]), np.array([0., 0.])]:
            x, y = point
            expected = {
                "bowl": [2 * (x - 1), 4 * (y + 2)],
                "coupled": [2 * (x * y + 1) * y, 2 * (x * y + 1) * x],
                "composed": [4 * (x + 2 * y) ** 3, 8 * (x + 2 * y) ** 3],
            }
            for name, gradient in expected.items():
                actual = model.analytic_gradient(name, point)
                assert np.shape(actual) == (2,)
                assert np.allclose(actual, gradient), f"Incorrect {name} gradient at {point}."

    def relative():
        for scale in [1., 1e-8, 1e8]:
            a, b = scale * np.array([3., 4.]), scale * np.array([0., 0.])
            assert np.isclose(model.relative_error(a, b), 1.)
            assert np.isclose(model.relative_error(a, 2 * a), 1 / 3)
        assert model.relative_error(np.zeros(2), np.zeros(2)) == 0.

    def checker():
        errors = []
        for name, f in FUNCTIONS.items():
            grad = lambda p: model.analytic_gradient(name, p)
            for point in [np.array([0.3, -0.7]), np.array([-1.2, 0.8])]:
                numeric = np.array([
                    (f(point + np.eye(2)[i] * 1e-5) -
                     f(point - np.eye(2)[i] * 1e-5)) / 2e-5
                    for i in range(2)
                ])
                a = np.asarray(grad(point))
                expected = np.linalg.norm(a - numeric) / max(
                    1e-12, np.linalg.norm(a) + np.linalg.norm(numeric))
                reported = model.check_gradient(f, grad, point)
                assert np.isclose(reported, expected, rtol=1e-3, atol=1e-12)
                errors.append(float(expected))
        metrics["max_relative_error"] = max(errors)
        assert max(errors) < 1e-5, f"Relative error is {max(errors):.3g}."
        bad = model.check_gradient(FUNCTIONS["bowl"], lambda p: -np.ones(2), np.array([2., 1.]))
        assert bad > 0.1, "The checker accepted a wrong gradient."

    def downhill():
        f = FUNCTIONS["bowl"]
        grad = lambda p: model.analytic_gradient("bowl", p)
        start = np.array([4., 3.])
        path, values = model.walk_downhill(f, grad, start)
        assert path.shape == (81, 2) and values.shape == (81,)
        assert np.array_equal(start, [4., 3.]), "The starting vector was changed."
        assert np.array_equal(path[0], start)
        assert np.allclose(path[1:], path[:-1] - 0.1 * np.array([grad(p) for p in path[:-1]]))
        assert np.allclose(values, [f(p) for p in path])
        assert np.all(np.diff(values) <= 1e-12), "The walk moved uphill."
        metrics["final_height"] = float(values[-1])
        assert values[-1] < 1e-8 and np.linalg.norm(path[-1] - [1., -2.]) < 1e-4

    def edge_cases():
        assert model.numerical_gradient(lambda p: 5., np.array([])).shape == (0,)
        assert model.relative_error(np.array([]), np.array([])) == 0.
        path, values = model.walk_downhill(FUNCTIONS["bowl"], lambda p: np.zeros(2),
                                          np.array([1., 2.]), steps=0)
        assert path.shape == (1, 2) and values.shape == (1,)
        for eps in [0., -1., np.nan, np.inf]:
            for action in [
                lambda: model.derivative(lambda t: t * t, 1., eps),
                lambda: model.numerical_gradient(FUNCTIONS["bowl"], np.ones(2), eps),
            ]:
                try:
                    action()
                except ValueError:
                    continue
                raise AssertionError("Invalid eps must raise ValueError.")
        try:
            model.analytic_gradient("missing", np.zeros(2))
        except ValueError:
            return
        raise AssertionError("Unknown function names must raise ValueError.")

    check("test_derivative", derivative, "Use both sides of x and divide by 2 * eps.")
    check("test_partial_derivatives", partials, "Move one coordinate at a time on independent copies.")
    check("test_analytic_chain_rule", analytic, "Include each inner derivative, including the factor 2 for y in composed.")
    check("test_relative_error", relative, "Divide the difference norm by the sum of norms with a 1e-12 floor.")
    check("test_gradient_checker", checker, "Report measured relative error and detect incorrect gradients.")
    check("test_downhill", downhill, "Subtract the gradient and save the initial point plus all 80 updates.")
    check("test_edge_cases", edge_cases, "Handle empty vectors, zero steps, invalid eps and unknown names.")
    return checks, metrics
