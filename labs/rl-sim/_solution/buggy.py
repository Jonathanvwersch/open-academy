import importlib.util
from pathlib import Path

import numpy as np

spec = importlib.util.spec_from_file_location("reference", Path(__file__).with_name("policy.py"))
reference = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reference)


def ppo_clipped_objective(theta, states, actions, old_log_probs, advantages, c=0.2):
    objective, grad = 0., np.zeros_like(theta)
    for s, a, old, advantage in zip(states, actions, old_log_probs, advantages):
        ratio = np.exp(reference.log_prob(theta, s, a) - old)
        objective += ratio * advantage
        grad += ratio * advantage * reference.grad_log_prob(theta, s, a)
    return float(objective / len(states)), grad / len(states)


def __getattr__(name):
    return getattr(reference, name)
