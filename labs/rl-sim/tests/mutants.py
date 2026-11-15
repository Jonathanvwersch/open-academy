import importlib.util
from pathlib import Path
from types import SimpleNamespace

import numpy as np

spec = importlib.util.spec_from_file_location(
    "reference", Path(__file__).resolve().parents[1] / "_solution" / "policy.py"
)
reference = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reference)


def make_mutant(name):
    model = SimpleNamespace(**{
        key: getattr(reference, key) for key in (
            "collect_episode", "returns_to_go", "action_probs", "log_prob",
            "grad_log_prob", "reinforce_update", "ppo_clipped_objective",
        )
    })

    def ppo(theta, states, actions, old_log_probs, advantages, c=0.2):
        value, _ = reference.ppo_clipped_objective(
            theta, states, actions, old_log_probs, advantages, c
        )
        grad = np.zeros_like(theta)
        for s, a, old, advantage in zip(states, actions, old_log_probs, advantages):
            ratio = np.exp(reference.log_prob(theta, s, a) - old)
            if name == "zero-outside":
                active = 1-c <= ratio <= 1+c
                weight = ratio
            else:
                active = not ((advantage > 0 and ratio > 1+c) or
                              (advantage < 0 and ratio < 1-c))
                weight = np.clip(ratio, 1-c, 1+c)
            grad += active * weight * advantage * reference.grad_log_prob(theta, s, a)
        return value, grad / len(states)

    def collect(env, theta, seed, rng):
        rng = np.random.default_rng(seed) if name == "own-rng" else np.random
        return reference.collect_episode(env, theta, seed, rng)

    if name in ("zero-outside", "clipped-weight"):
        model.ppo_clipped_objective = ppo
    elif name in ("own-rng", "global-rng"):
        model.collect_episode = collect
    else:
        raise ValueError(name)
    return model
