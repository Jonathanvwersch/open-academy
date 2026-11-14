"""Public checks. Every check corresponds to one authored project test ID."""

import numpy as np

from tiny_lm import (
    HIDDEN, RANK, V, batch, examples, generate, hidden,
    preference_pairs, pretrain, softmax, train_adapter, train_reward,
)


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def run_checks(model):
    checks, metrics = [], {}

    def check(check_id, fn):
        try:
            message = fn()
            checks.append({"id": check_id, "passed": True, "message": message})
        except Exception as error:
            checks.append({"id": check_id, "passed": False, "message": f"{type(error).__name__}: {error}"})

    def mask_check():
        tokens = np.arange(6)
        actual = model.response_mask(tokens, 4)
        require(np.array_equal(actual, [0, 0, 0, 1, 1]),
                "Mask targets tokens[1:]; the first response target and <eos> both count.")
        require(np.array_equal(model.response_mask(tokens, 1), np.ones(5)),
                "Every target counts when the response starts at original token index 1.")
        return "The shifted target mask includes the first response token and the end token."

    def loss_check():
        logits = np.array([[1000., -1000., 0.], [0., 0., 0.], [0., np.log(2), 0.]])
        targets, mask = np.array([1, 2, 1]), np.array([0., 1., 1.])
        before = logits.copy()
        loss, grad = model.masked_loss(logits, targets, mask)
        expected = (np.log(3) + np.log(2)) / 2
        require(np.isclose(loss, expected, atol=1e-10),
                f"Response loss should be {expected:.6f}; got {loss:.6f}. Divide by mask.sum(), the number of response targets.")
        expected_grad = np.array([[0., 0., 0.], [1/6, 1/6, -1/3], [1/8, -1/4, 1/8]])
        require(np.allclose(grad, expected_grad, atol=1e-10),
                "Zero prompt-target gradients and divide response gradients by mask.sum().")
        require(np.array_equal(logits, before), "masked_loss must keep its input logits unchanged.")
        changed = logits.copy()
        changed[0] = [-1000, 1000, 0]
        require(np.isclose(model.masked_loss(changed, targets, mask)[0], loss),
                "Changing a masked prompt prediction must leave response loss unchanged.")
        extreme_loss, extreme_grad = model.masked_loss(logits[:1], targets[:1], np.ones(1))
        require(np.isfinite(extreme_loss) and np.isfinite(extreme_grad).all(),
                "Use shifted log probabilities so large logits keep finite loss and gradients.")
        try:
            model.masked_loss(logits, targets, np.zeros(3))
        except ValueError:
            return "Response mean, gradient normalization, numerical stability, and empty masks pass."
        raise AssertionError("Reject an empty mask with ValueError.")

    def adapter_check():
        A, B = model.init_adapter(7, 5, 2, seed=13)
        expected_A = np.random.default_rng(13).normal(0, 0.1, (2, 7))
        require(A.shape == (2, 7) and B.shape == (5, 2), "A is (rank, n_in); B is (n_out, rank).")
        require(np.array_equal(A, expected_A) and np.count_nonzero(B) == 0,
                "Start A from the specified seeded normal draw and B at zero.")
        W = np.arange(35.).reshape(5, 7) / 10
        old = W.copy()
        require(np.array_equal(model.adapted_weight(W, A, B), W), "A zero B must preserve base predictions.")
        B[:] = np.arange(10).reshape(5, 2) / 10
        effective = model.adapted_weight(W, A, B)
        x = np.arange(7.)
        require(np.allclose(effective @ x, W @ x + B @ (A @ x)), "The merged layer must equal W x + B(A x).")
        require(np.array_equal(W, old), "Building the effective matrix must keep W frozen.")
        require(RANK * (V + HIDDEN) < V * HIDDEN, "The adapter should train fewer values than the output matrix.")
        return "Seeded thin matrices, zero initial change, frozen weights, and merging pass."

    def sft_check():
        rng = np.random.default_rng(31)
        base = {"encoder": rng.normal(0, .1, (4, 6)), "bias": np.zeros(4), "W": rng.normal(0, .1, (3, 4))}
        snapshot = {k: v.copy() for k, v in base.items()}
        A, B = rng.normal(0, .1, (2, 4)), rng.normal(0, .1, (3, 2))
        old_A, old_B = A.copy(), B.copy()
        X, targets, mask = rng.normal(size=(5, 6)), np.array([0, 2, 1, 2, 0]), np.array([0., 1., 1., 0., 1.])
        h = hidden(base, X)
        probs = softmax(h @ (base["W"] + B @ A).T)
        expected_loss = -np.sum(np.log(probs[np.arange(5), targets]) * mask) / mask.sum()
        grad = probs.copy()
        grad[np.arange(5), targets] -= 1
        dW = (grad * mask[:, None] / mask.sum()).T @ h
        loss = model.sft_step(base, A, B, X, targets, mask, .2)
        require(np.isclose(loss, expected_loss), "Return the response loss before updating the adapter.")
        require(np.allclose(A, old_A - .2 * (old_B.T @ dW)) and np.allclose(B, old_B - .2 * (dW @ old_A.T)),
                "Compute dA = B.T @ dW and dB = dW @ A.T before changing either matrix.")
        require(all(np.array_equal(base[k], v) for k, v in snapshot.items()),
                "SFT must leave the encoder, bias, and pretrained W unchanged.")
        return "One supervised step updates both adapter factors from the old values and freezes the base."

    def preference_check():
        chosen, rejected = np.array([.5, 2., -2.]), np.array([1.5, 0., 2.])
        diff = chosen - rejected
        loss, dc, dr = model.preference_loss(chosen, rejected)
        probability = 1 / (1 + np.exp(-diff))
        require(np.isclose(loss, -np.log(probability).mean()), "Use mean -log(sigmoid(chosen - rejected)).")
        require(np.allclose(dc, (probability - 1) / 3) and np.allclose(dr, -dc),
                "Chosen gradients are (p-1)/pairs; rejected gradients have the opposite sign.")
        shifted = model.preference_loss(chosen + 10, rejected + 10)
        require(np.isclose(shifted[0], loss), "A common score offset must leave preference loss unchanged.")
        extreme = model.preference_loss(np.array([-1000., 1000.]), np.zeros(2))
        require(all(np.isfinite(value).all() for value in extreme), "Use stable loss and probability calculations for large score gaps.")
        return "Preference loss, both gradients, score-offset invariance, and extreme scores pass."

    def reward_step_check():
        chosen = np.array([[1., 0.], [0., 2.]])
        rejected = np.array([[0., 1.], [1., 0.]])
        weights = np.zeros(2)
        loss = model.reward_step(weights, chosen, rejected, .2)
        expected = .2 * (chosen - rejected).mean(axis=0) / 2
        require(np.isclose(loss, np.log(2)) and np.allclose(weights, expected),
                "Backpropagate through both linear scores, then subtract learning_rate * gradient.")
        return "A preference update moves linear reward weights toward chosen-minus-rejected features."

    def split_check():
        train, validation = examples(), examples("validation")
        train_prompts = {row["prompt"] for row in train}
        require(train_prompts.isdisjoint(row["prompt"] for row in validation), "Keep validation prompts out of training.")
        require(train == examples() and len(train) == len(validation) == 8, "Data generation must be repeatable with eight prompts per split.")
        require(train_prompts == {row["prompt"] for row in examples(uppercase=False)},
                "Pretraining and SFT may use only training-split prompts.")
        X, targets, mask = batch(train, model.response_mask)
        require(len(X) == len(targets) == len(mask) and mask.sum() == 16,
                "Each training response has two targets: its answer and <eos>.")
        return "Eight SFT/pretraining prompts and eight held-out evaluation prompts are disjoint."

    def evaluation_check():
        base = pretrain()
        snapshot = {k: v.copy() for k, v in base.items()}
        A, B, history = train_adapter(model, base)
        require(all(np.array_equal(base[k], v) for k, v in snapshot.items()), "The complete SFT run must keep every base array frozen.")
        rows = examples("validation")
        before = [generate(base, base["W"], row["prompt"]) for row in rows]
        after = [generate(base, model.adapted_weight(base["W"], A, B), row["prompt"]) for row in rows]
        base_accuracy = np.mean([answer == row["response"] for answer, row in zip(before, rows)])
        accuracy = np.mean([answer == row["response"] for answer, row in zip(after, rows)])
        lowercase = np.mean([answer == row["response"].lower() for answer, row in zip(before, rows)])
        metrics.update(base_exact_match=float(base_accuracy), adapted_exact_match=float(accuracy), exact_match_gain=float(accuracy-base_accuracy))
        X, targets, mask = batch(examples(), model.response_mask)
        logits = hidden(base, X) @ model.adapted_weight(base["W"], A, B).T
        shifted = logits - logits.max(axis=1, keepdims=True)
        log_probs = shifted - np.log(np.exp(shifted).sum(axis=1, keepdims=True))
        metrics["sft_response_loss"] = float(-np.sum(log_probs[np.arange(len(targets)), targets] * mask) / mask.sum())
        require(lowercase >= .9, "Pretraining should learn the lowercase echo task before adaptation.")
        require(np.isfinite(history).all() and history[-1] < history[0], "SFT training loss must fall and remain finite.")
        require(base_accuracy < .25 and accuracy > .9 and accuracy - base_accuracy > .75 and metrics["sft_response_loss"] < .1,
                f"Held-out exact match: base {base_accuracy:.3f}, adapted {accuracy:.3f}. Require base < 0.25, adapted > 0.9, gain > 0.75, and response loss < 0.1.")
        return f"Greedy full-response exact match: base {base_accuracy:.3f}, adapted {accuracy:.3f}; includes <eos>."

    def reward_check():
        weights, history = train_reward(model)
        chosen, rejected = preference_pairs("validation")
        difference = chosen @ weights - rejected @ weights
        accuracy = float(np.mean(difference > 0))
        metrics["reward_pair_accuracy"] = accuracy
        require(np.isfinite(history).all() and history[-1] < history[0], "Preference training must lower a finite loss.")
        require(accuracy > .9, f"Held-out pair accuracy is {accuracy:.3f}; require > 0.9. Check the chosen-minus-rejected sign.")
        return f"The separate reward model ranks {accuracy:.1%} of held-out pairs correctly."

    def win_rate_check():
        rate = model.win_rate(np.array([1, 0, -1, 0, 1]))
        require(np.isclose(rate, .6), "Two wins, two ties, and one loss give (2 + 0.5*2)/5 = 0.6.")
        require(model.win_rate(np.array([0, 0])) == .5 and model.win_rate(np.array([-1, -1])) == 0,
                "Ties get half credit and losses remain in the denominator.")
        try:
            model.win_rate(np.array([]))
        except ValueError:
            return "Tie-adjusted win rate counts every comparison and rejects empty evaluations."
        raise AssertionError("Reject empty comparisons with ValueError.")

    for check_id, fn in [
        ("test_response_mask_alignment", mask_check),
        ("test_masked_loss_and_gradient", loss_check),
        ("test_adapter_initialization_and_merge", adapter_check),
        ("test_sft_step_and_frozen_base", sft_check),
        ("test_preference_loss_and_gradients", preference_check),
        ("test_reward_step", reward_step_check),
        ("test_split_is_disjoint", split_check),
        ("test_before_after_evaluation", evaluation_check),
        ("test_reward_ranks_held_out_pairs", reward_check),
        ("test_win_rate_counts_ties", win_rate_check),
    ]:
        check(check_id, fn)
    return checks, metrics
