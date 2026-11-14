import numpy as np


def collect_episode(env, theta, seed, rng):
    """Record s_t, a_t and r_{t+1}, stopping at termination."""
    states, actions, rewards = [], [], []
    state = env.reset(seed)
    done = False
    while not done:
        action = int(rng.choice(theta.shape[1], p=action_probs(theta, state)))
        states.append(state)
        actions.append(action)
        state, reward, done = env.step(action)
        rewards.append(reward)
    return np.array(states, dtype=int), np.array(actions, dtype=int), np.array(rewards)


def returns_to_go(rewards, gamma):
    if not 0 <= gamma <= 1:
        raise ValueError("gamma must be between zero and one")
    result = np.zeros(len(rewards))
    total = 0.
    for t in reversed(range(len(rewards))):
        total = rewards[t] + gamma * total
        result[t] = total
    return result


def action_probs(theta, state):
    shifted = theta[state] - np.max(theta[state])
    weights = np.exp(shifted)
    return weights / weights.sum()


def log_prob(theta, state, action):
    shifted = theta[state] - np.max(theta[state])
    return float(shifted[action] - np.log(np.exp(shifted).sum()))


def grad_log_prob(theta, state, action):
    grad = np.zeros_like(theta)
    grad[state] = -action_probs(theta, state)
    grad[state, action] += 1
    return grad


def reinforce_update(theta, states, actions, advantages, eta):
    if len(states) == 0:
        raise ValueError("batch must be nonempty")
    shifted = theta[states] - theta[states].max(axis=1, keepdims=True)
    probs = np.exp(shifted)
    probs /= probs.sum(axis=1, keepdims=True)
    residual = -probs
    residual[np.arange(len(states)), actions] += 1
    grad = np.zeros_like(theta)
    np.add.at(grad, states, advantages[:, None] * residual)
    return theta + eta * grad / len(states)


def ppo_clipped_objective(theta, states, actions, old_log_probs, advantages, c=0.2):
    """Return mean clipped surrogate and its ascent gradient."""
    if len(states) == 0:
        raise ValueError("batch must be nonempty")
    if not 0 < c < 1:
        raise ValueError("c must lie between zero and one")
    shifted = theta[states] - theta[states].max(axis=1, keepdims=True)
    log_probs = shifted - np.log(np.exp(shifted).sum(axis=1, keepdims=True))
    ratio = np.exp(log_probs[np.arange(len(states)), actions] - old_log_probs)
    objective = np.minimum(ratio * advantages, np.clip(ratio, 1-c, 1+c) * advantages)
    active = ~(((advantages > 0) & (ratio > 1+c)) | ((advantages < 0) & (ratio < 1-c)))
    residual = -np.exp(log_probs)
    residual[np.arange(len(states)), actions] += 1
    grad = np.zeros_like(theta)
    np.add.at(grad, states, (active * ratio * advantages)[:, None] * residual)
    return float(objective.mean()), grad / len(states)
