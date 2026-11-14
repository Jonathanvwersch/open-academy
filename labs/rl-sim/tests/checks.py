"""Independent exact-value, numerical-gradient and fixed-seed checks."""
import numpy as np

from environment import GridWorld, evaluate, ratio_probe, train


def numerical(fn, theta):
    grad = np.zeros_like(theta)
    for index in np.ndindex(theta.shape):
        plus, minus = theta.copy(), theta.copy()
        plus[index] += 1e-6
        minus[index] -= 1e-6
        grad[index] = (fn(plus) - fn(minus)) / 2e-6
    return grad


def rejects(fn):
    try:
        fn()
    except ValueError:
        return
    raise AssertionError("Expected ValueError for invalid or empty input.")


def run_checks(model):
    checks, metrics = [], {}

    def check(name, hint, fn):
        try:
            fn()
            checks.append({"id": name, "passed": True, "message": hint})
        except Exception as error:
            checks.append({"id": name, "passed": False,
                           "message": f"{hint} {type(error).__name__}: {error}"})

    def episode():
        class Scripted:
            def reset(self, seed):
                self.t = 0
                assert seed == 7
                return 2

            def step(self, action):
                assert action in range(4)
                self.t += 1
                assert self.t <= 2, "Stop when done is True."
                return 2 + self.t, float(self.t), self.t == 2

        first = model.collect_episode(Scripted(), np.zeros((25, 4)), 7, np.random.default_rng(9))
        second = model.collect_episode(Scripted(), np.zeros((25, 4)), 7, np.random.default_rng(9))
        np.testing.assert_array_equal(first[0], [2, 3])
        np.testing.assert_array_equal(first[2], [1, 2])
        for a, b in zip(first, second):
            np.testing.assert_array_equal(a, b)
        env = GridWorld()
        assert env.reset(3) == 0
        for a in [1] * 4 + [2] * 4:
            state, reward, done = env.step(a)
        assert (state, reward, done) == (24, 1., True)
        rejects(lambda: env.step(1))
        env.reset(3)
        rejects(lambda: env.step(4))
        for _ in range(50):
            state, reward, done = env.step(0)
        assert (state, reward, done) == (0, -0.02, True)

    check("collect-episode", "Record pre-action states and r_{t+1}; stop at done and reuse the supplied rng.", episode)

    def returns():
        got = model.returns_to_go([1, 1, 1], 0.9)
        assert np.allclose(got, [2.71, 1.9, 1]), (
            f"returns_to_go([1,1,1], 0.9) gave {got}; expected [2.71,1.9,1]. Did you forget to discount?")
        np.testing.assert_array_equal(model.returns_to_go([], 0.9), [])
        np.testing.assert_allclose(model.returns_to_go([2, -1], 0), [2, -1])
        np.testing.assert_allclose(model.returns_to_go([2, -1], 1), [1, -1])
        rejects(lambda: model.returns_to_go([1], -0.1))
        rejects(lambda: model.returns_to_go([1], 1.1))

    check("returns-to-go", "Use G_t = r_{t+1} + gamma G_{t+1}.", returns)
    theta = np.array([[0.2, -0.4, 0.7, 0.1], [1., -1., 0.3, 0.2]])

    def probabilities():
        expected = np.exp(theta[0]) / np.exp(theta[0]).sum()
        np.testing.assert_allclose(model.action_probs(theta, 0), expected)
        for a in range(4):
            np.testing.assert_allclose(model.log_prob(theta, 0, a), np.log(expected[a]))
        large = np.array([[1000., -1000., 1000., -1000.]])
        np.testing.assert_allclose(model.action_probs(large, 0), [0.5, 0, 0.5, 0])
        np.testing.assert_allclose(model.log_prob(large, 0, 1), -2000 - np.log(2))
        np.testing.assert_allclose(model.action_probs(theta + 9000, 0), expected)

    check("policy-probabilities", "Subtract the largest logit; calculate log probabilities before exponentiation.", probabilities)

    def gradient():
        analytic = model.grad_log_prob(theta, 0, 2)
        np.testing.assert_allclose(analytic, numerical(lambda t: model.log_prob(t, 0, 2), theta), atol=1e-8)
        np.testing.assert_allclose(analytic[1], 0, atol=1e-12)
        np.testing.assert_allclose(analytic.sum(axis=1), 0, atol=1e-12)

    check("policy-gradient", "The active row is one_hot(a) - pi_theta(.|s); other rows are zero.", gradient)
    s, a, adv = np.array([0, 1]), np.array([2, 0]), np.array([1.5, -0.5])
    old = np.array([-1., -0.7])

    def reinforce():
        original = theta.copy()
        expected = theta.copy()
        for state, action, advantage in zip(s, a, adv):
            p = np.exp(theta[state]) / np.exp(theta[state]).sum()
            row = -p
            row[action] += 1
            expected[state] += 0.3 * advantage * row / 2
        got = model.reinforce_update(theta, s, a, adv, 0.3)
        np.testing.assert_allclose(got, expected)
        np.testing.assert_array_equal(theta, original)
        np.testing.assert_allclose(model.reinforce_update(theta, s, a, adv * 0, 0.3), theta)
        rejects(lambda: model.reinforce_update(theta, s[:0], a[:0], adv[:0], 0.3))

    check("reinforce-update", "Ascend the mean advantage-weighted gradient with learning rate eta; preserve inputs.", reinforce)

    def objective():
        t = np.zeros((1, 4))
        for ratio, advantage in [(1.5, 2), (0.5, -2), (0.5, 2), (1.5, -2), (1., 2)]:
            previous = np.array([np.log(0.25 / ratio)])
            value, grad = model.ppo_clipped_objective(t, np.array([0]), np.array([0]), previous, np.array([advantage]))
            expected = min(ratio * advantage, np.clip(ratio, 0.8, 1.2) * advantage)
            np.testing.assert_allclose(value, expected, err_msg="Use min(rho*A_hat, clip(rho,1-c,1+c)*A_hat), including negative advantages.")
            if (ratio > 1.2 and advantage > 0) or (ratio < 0.8 and advantage < 0):
                np.testing.assert_allclose(grad, 0, atol=1e-12, err_msg="The clipped branch is flat. Its gradient must be zero.")
        rejects(lambda: model.ppo_clipped_objective(theta, s[:0], a[:0], old[:0], adv[:0]))
        rejects(lambda: model.ppo_clipped_objective(theta, s, a, old, adv, 0))

    check("ppo-objective", "Clipping must cap favorable changes for both advantage signs.", objective)

    def ppo_gradient():
        original = theta.copy()
        value, grad = model.ppo_clipped_objective(theta, s, a, old, adv)
        numeric = numerical(lambda t: model.ppo_clipped_objective(t, s, a, old, adv)[0], theta)
        np.testing.assert_allclose(grad, numeric, atol=1e-8)
        np.testing.assert_array_equal(theta, original)
        repeated, repeated_grad = model.ppo_clipped_objective(theta, np.tile(s, 2), np.tile(a, 2), np.tile(old, 2), np.tile(adv, 2))
        np.testing.assert_allclose(repeated, value)
        np.testing.assert_allclose(repeated_grad, grad)

    check("ppo-gradient", "Differentiate the active surrogate branch and average over the batch.", ppo_gradient)

    def performance(method):
        random = evaluate(model, np.zeros((25, 4)))
        score = evaluate(model, train(model, method))
        metrics["random-return"] = random
        metrics[method + "-return"] = score
        assert np.isfinite(score) and score > 0.5 and score - random > 0.7, (
            f"{method} return {score:.4f}, random {random:.4f}; need return > 0.5 and gain > 0.7. Check ascent sign, baseline and discounted returns.")

    check("reinforce-evaluation", "REINFORCE must beat random on 100 held-out evaluation seeds.", lambda: performance("reinforce"))
    check("ppo-evaluation", "PPO must beat random on the same held-out evaluation seeds.", lambda: performance("ppo"))

    def clipping():
        ratio = ratio_probe(model)
        metrics["ppo-probe-ratio"] = ratio
        assert 1.19 < ratio < 1.3, (
            f"PPO probe ratio {ratio:.4f}; expected 1.19 < rho < 1.3. Freeze old log probabilities across epochs and zero the clipped gradient. An unclipped ratio keeps growing.")

    check("ppo-ratio-clip", "Small repeated PPO steps should stop near 1+c; clipping is not a hard ratio constraint.", clipping)
    return checks, {k: v for k, v in metrics.items() if np.isfinite(v)}
