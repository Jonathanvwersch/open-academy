"""Public deterministic checks. Each check reports independently."""
import numpy as np


def run_checks(model):
    checks, scores = [], {}

    def check(name, message, test):
        try:
            test()
            checks.append({"id": name, "passed": True, "message": message})
        except Exception as error:
            checks.append({"id": name, "passed": False,
                           "message": f"{message} {type(error).__name__}: {error}"})

    def sigmoid():
        z = np.array([-1000., -2., 0., 2., 1000.])
        with np.errstate(over="raise", invalid="raise"):
            p = model.sigmoid(z)
        np.testing.assert_allclose(p, [0, 0.119202922, 0.5, 0.880797078, 1], atol=1e-9)
        assert p.shape == z.shape

    check("test_sigmoid", "Sigmoid must preserve shape and handle scores from -1000 to 1000.", sigmoid)

    def softmax():
        z = np.array([[1000., 1001., 1002.], [-1000., -1000., -1000.]])
        with np.errstate(over="raise", invalid="raise", divide="raise"):
            p = model.softmax(z)
            shifted = model.softmax(z + 9000)
            X = np.eye(2)
            loss, _, _ = model.multiclass_loss_grad(X, np.array([0, 2]), z, np.zeros(3))
        expected = np.array([[0.09003057317, 0.24472847105, 0.66524095577], [1/3, 1/3, 1/3]])
        np.testing.assert_allclose(p, expected)
        np.testing.assert_allclose(p, shifted)
        np.testing.assert_allclose(p.sum(axis=1), 1)
        np.testing.assert_allclose(loss, (2.40760596444 + np.log(3)) / 2)

    check("test_stable_softmax_logsumexp",
          "Subtract each row maximum before exponentiation; loss must use stable log-sum-exp.", softmax)

    X = np.array([[0.2, -0.7], [1.1, 0.4], [-0.3, 0.8], [0.6, -0.2]])

    def gradients(classes):
        y = np.array([0, 1, 1, 0]) if classes == 2 else np.array([0, 2, 1, 0])
        w = np.array([0.3, -0.2]) if classes == 2 else np.array([[0.3, -0.2, 0.1], [-0.4, 0.2, 0.5]])
        b = np.array(0.1) if classes == 2 else np.array([0.1, -0.2, 0.3])
        objective = model.binary_loss_grad if classes == 2 else model.multiclass_loss_grad
        loss, dw, db = objective(X, y, w, b)
        z = X @ w + b
        if classes == 2:
            expected = -np.mean(y * np.log(1 / (1 + np.exp(-z))) + (1-y) * np.log(1 / (1 + np.exp(z))))
        else:
            expected = np.mean(np.log(np.exp(z).sum(axis=1)) - z[np.arange(len(y)), y])
        np.testing.assert_allclose(loss, expected, atol=1e-12)
        assert np.shape(dw) == w.shape and np.shape(db) == b.shape
        for parameter, analytic in ((w, dw), (b, db)):
            numeric = np.zeros_like(parameter)
            for index in np.ndindex(parameter.shape):
                original = parameter[index]
                parameter[index] = original + 1e-5
                plus = objective(X, y, w, b)[0]
                parameter[index] = original - 1e-5
                minus = objective(X, y, w, b)[0]
                parameter[index] = original
                numeric[index] = (plus - minus) / 2e-5
            np.testing.assert_allclose(analytic, numeric, atol=1e-8, rtol=1e-5)
        doubled = objective(np.tile(X, (2, 1)), np.tile(y, 2), w, b)
        for actual, repeated in zip((loss, dw, db), doubled):
            np.testing.assert_allclose(actual, repeated)

    check("test_binary_loss_gradient", "Binary loss and gradients must be means and match finite differences.", lambda: gradients(2))
    check("test_multiclass_loss_gradient", "Multiclass loss and gradients must match finite differences, including bias.", lambda: gradients(3))

    def step():
        for classes in (2, 3):
            y = np.array([0, 1, 1, 0]) if classes == 2 else np.array([0, 2, 1, 0])
            w0 = np.zeros(2) if classes == 2 else np.zeros((2, classes))
            b0 = 0.0 if classes == 2 else np.zeros(classes)
            objective = model.binary_loss_grad if classes == 2 else model.multiclass_loss_grad
            initial, dw, db = objective(X, y, w0, b0)
            w, b, history = model.train(X, y, classes, lr=0.1, steps=1)
            np.testing.assert_allclose(w, w0 - 0.1 * dw)
            np.testing.assert_allclose(b, b0 - 0.1 * db)
            np.testing.assert_allclose(history, [initial, objective(X, y, w, b)[0]])
            assert history[-1] < history[0]
            w, b, history = model.train(X, y, classes, steps=0)
            np.testing.assert_equal(w, w0)
            np.testing.assert_equal(b, b0)
            np.testing.assert_allclose(history, [initial])

    check("test_training_step", "Start from zeros and subtract learning rate times gradient; zero steps returns initial loss.", step)

    def confusion():
        y = np.array([0, 0, 0, 1, 1, 2])
        predicted = np.array([0, 1, 1, 1, 2, 2])
        np.testing.assert_array_equal(model.confusion_matrix(y, predicted, 3), [[1, 2, 0], [0, 1, 1], [0, 0, 1]])
        np.testing.assert_array_equal(model.confusion_matrix(np.array([], dtype=int), np.array([], dtype=int), 3), np.zeros((3, 3)))

    check("test_confusion_matrix", "Rows are true classes, columns are predicted classes; count every example.", confusion)

    def metrics():
        matrix = np.array([[4, 2, 0], [1, 1, 0], [0, 0, 0]])
        accuracy, precision, recall = model.metrics(matrix)
        np.testing.assert_allclose(accuracy, 5/8)
        np.testing.assert_allclose(precision, [4/5, 1/3, 0], err_msg="Precision divides by predicted column totals.")
        np.testing.assert_allclose(recall, [4/6, 1/2, 0], err_msg="Recall divides by actual row totals.")
        accuracy, precision, recall = model.metrics(np.zeros((3, 3), dtype=int))
        assert accuracy == 0
        np.testing.assert_equal(precision, np.zeros(3))
        np.testing.assert_equal(recall, np.zeros(3))

    check("test_precision_recall", "Precision uses column totals; recall uses row totals. Empty denominators give zero.", metrics)

    def held_out(classes):
        train_X, train_y, val_X, val_y = model.make_data(classes)
        w, b, _ = model.train(train_X, train_y, classes)
        logits = val_X @ w + b
        predicted = (model.sigmoid(logits) >= 0.5).astype(int) if classes == 2 else model.softmax(logits).argmax(axis=1)
        # Evaluate independently of the learner's metric implementation.
        accuracy = float(np.mean(predicted == val_y))
        key = "binary_accuracy" if classes == 2 else "multiclass_accuracy"
        scores[key] = accuracy
        assert accuracy > 0.90, f"Held-out accuracy {accuracy:.3f} must exceed 0.90."

    check("test_binary_held_out", "Fit binary training data only; held-out accuracy must exceed 0.90.", lambda: held_out(2))
    check("test_multiclass_held_out", "Fit three-class training data only; held-out accuracy must exceed 0.90.", lambda: held_out(3))
    return checks, scores
