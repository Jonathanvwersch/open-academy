import numpy as np


def action_probs(theta, state):
    """Return stable action probabilities for one state."""
    raise NotImplementedError("TODO: action_probs")


def log_prob(theta, state, action):
    """Return a stable scalar log probability."""
    raise NotImplementedError("TODO: log_prob")


def collect_episode(env, theta, seed, rng):
    """Return aligned arrays of states, actions and rewards through done."""
    raise NotImplementedError("TODO: collect_episode")


def returns_to_go(rewards, gamma):
    """Return discounted returns with shape (T,)."""
    raise NotImplementedError("TODO: returns_to_go")


def grad_log_prob(theta, state, action):
    """Return the log probability gradient with theta's shape."""
    raise NotImplementedError("TODO: grad_log_prob")


def reinforce_update(theta, states, actions, advantages, eta):
    """Return a new theta after mean policy-gradient ascent."""
    raise NotImplementedError("TODO: reinforce_update")


def ppo_clipped_objective(theta, states, actions, old_log_probs, advantages, c=0.2):
    """Return mean clipped objective and gradient."""
    raise NotImplementedError("TODO: ppo_clipped_objective")
