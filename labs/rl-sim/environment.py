"""Provided deterministic gridworld and training harness."""
import numpy as np


class GridWorld:
    n_states = 25
    n_actions = 4

    def reset(self, seed):
        self.state = int(np.random.default_rng(seed).integers(24))
        self.steps, self.done = 0, False
        return self.state

    def step(self, action):
        if self.done:
            raise ValueError("Episode ended; call reset(seed).")
        if action not in range(4):
            raise ValueError("Action must be 0, 1, 2 or 3.")
        row, col = divmod(self.state, 5)
        dr, dc = ((-1, 0), (0, 1), (1, 0), (0, -1))[action]
        self.state = int(np.clip(row + dr, 0, 4) * 5 + np.clip(col + dc, 0, 4))
        self.steps += 1
        self.done = self.state == 24 or self.steps == 50
        return self.state, (1.0 if self.state == 24 else -0.02), self.done


EVAL_SEEDS = tuple(range(1000000, 1000100))


def train(model, method, seed=0, batches=100, batch_size=12):
    if method not in ("reinforce", "ppo"):
        raise ValueError("method must be reinforce or ppo")
    rng = np.random.default_rng(seed)
    theta, values = np.zeros((25, 4)), np.zeros(25)
    for batch in range(batches):
        states, actions, targets = [], [], []
        for episode in range(batch_size):
            s, a, r = model.collect_episode(
                GridWorld(), theta, seed * 10000 + batch * batch_size + episode, rng)
            states.extend(s)
            actions.extend(a)
            targets.extend(model.returns_to_go(r, 0.97))
        states, actions = np.array(states, dtype=int), np.array(actions, dtype=int)
        targets = np.array(targets)
        advantages = targets - values[states]
        if method == "reinforce":
            theta = model.reinforce_update(theta, states, actions, advantages, 8.0)
        else:
            old = np.array([model.log_prob(theta, s, a) for s, a in zip(states, actions)])
            for _ in range(6):
                _, grad = model.ppo_clipped_objective(theta, states, actions, old, advantages, 0.2)
                theta = theta + 2.0 * grad
        for s in np.unique(states):
            values[s] += 0.5 * (targets[states == s].mean() - values[s])
    return theta


def evaluate(model, theta):
    totals = []
    for seed in EVAL_SEEDS:
        _, _, rewards = model.collect_episode(GridWorld(), theta, seed, np.random.default_rng(seed))
        totals.append(sum(rewards))
    return float(np.mean(totals))


def ratio_probe(model, seed=0):
    """Controlled single-state batch; repeated ascent uses frozen old probabilities."""
    theta = np.zeros((25, 4))
    states, actions = np.array([0]), np.array([seed % 4])
    old = np.array([-np.log(4.)])
    for _ in range(20):
        _, grad = model.ppo_clipped_objective(theta, states, actions, old, np.array([1.]), 0.2)
        theta += 0.1 * grad
    return float(np.exp(model.log_prob(theta, 0, actions[0]) - old[0]))
