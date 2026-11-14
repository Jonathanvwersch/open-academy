# RL policy in simulation

Train two policies to cross a small grid. All computation uses NumPy on a CPU.
After installing NumPy, the lab works offline.

## Setup

Run these commands from the repository root:

```bash
python3 -m pip install -r labs/rl-sim/requirements.txt
python3 labs/rl-sim/setup.py
# edit labs/rl-sim/work/policy.py
python3 labs/verify.py rl-sim
```

Setup copies missing starter files and preserves existing work.
Upload `labs/rl-sim/work/results.json` on the project page.
The verifier trains fresh policies and uses fixed evaluation seeds.

## Environment and notation

Read the provided `environment.py`. The grid has five rows and five columns.
State s is row * 5 + column. Reset draws a start uniformly from states 0 through 23
using `np.random.default_rng(seed).integers(24)`.
The goal is state 24. Actions a are up, right, down and left, numbered 0 to 3.
A boundary action leaves the state unchanged.
The goal transition gives reward r_{t+1} = 1. Every other transition gives -0.02.
An episode ends at the goal or after 50 actions.
The start is deterministic given the reset seed. Transitions are deterministic.
The policy samples actions with the supplied rng.

The feature vector is one-hot with 25 entries. Parameters theta have shape (25, 4).
Multiplying the feature vector by theta selects a row of action logits.
The policy pi_theta(a|s) is the softmax of that row.
V^pi(s) is expected discounted return from s under pi.
Q^pi(s,a) is expected discounted return after taking a in s and then following pi.
Their difference is an advantage. We estimate it using sampled returns and a baseline.

## Small functions

1. `collect_episode(env, theta, seed, rng)` resets once and samples actions with
   `rng.choice`. Return three aligned arrays of length T. Entry t holds s_t,
   a_t and r_{t+1}. Record the state before the action. Stop at done.
2. `returns_to_go(rewards, gamma)` computes G_t backwards:
   G_t = r_{t+1} + gamma G_{t+1}, with G_T = 0.
   Empty rewards give an empty array.
3. `action_probs(theta, state)` returns four probabilities. Subtract the
   largest logit before exponentiation. `log_prob` returns the scalar natural
   log probability directly from shifted logits and log-sum-exp. It must stay
   finite when an unlikely action's probability underflows to zero.
4. `grad_log_prob` returns an array shaped like theta. Its active row is
   one_hot(a) - pi_theta(.|s). Every other row is zero.
5. `reinforce_update(theta, states, actions, advantages, eta)` returns a new
   array: theta + eta * mean(A_hat_t * grad_log_prob).
   Keep theta unchanged.
6. `ppo_clipped_objective(theta, states, actions, old_log_probs, advantages, c=0.2)`
   returns the mean surrogate and its gradient for ascent:
   rho_t(theta) = exp(log pi_theta(a_t|s_t) - old_log_probs[t]).
   The surrogate is min(rho_t * A_hat_t, clip(rho_t, 1-c, 1+c) * A_hat_t).
   Its gradient is zero when A_hat_t > 0 and rho_t > 1+c, or when
   A_hat_t < 0 and rho_t < 1-c. Otherwise it is
   rho_t * A_hat_t * grad_log_prob. At a boundary use this latter gradient.
   Average both outputs over the batch. Preserve inputs.

## Provided training and evaluation

The harness runs 100 batches of 12 episodes with discount gamma = 0.97.
The one-hot value baseline starts at zero. Before fitting the baseline, it
computes A_hat_t = G_t - V(s_t). After the policy update, each visited state's
value moves halfway toward that batch's mean return for the state.
This is a Monte Carlo estimate of V^pi(s).

REINFORCE takes one step per batch with learning rate eta = 8.
PPO takes six steps with eta = 2 and clip range c = 0.2.
Old log probabilities and advantages stay fixed across those six epochs.
Training seeds are seed * 10000 + episode index. The verifier uses seed 0.
Evaluation uses 100 seeds from 1000000 through 1000099 and stochastic actions.
These held-out seeds select start cells as well as action-sampling sequences.
Training and evaluation share the grid and can visit the same start cells.
No evaluation episode is used for updates.
The metric is mean undiscounted episode return. Zero logits define the random policy.
Each trained policy must score above 0.5 and improve on random by more than 0.7.
For context, a shortest-path policy scores 0.9438 on these evaluation starts.
From a start at row i and column j, it takes d = 8 - i - j actions and earns
1 - 0.02 * (d - 1).

The ratio probe freezes a single old probability of 0.25 and advantage of 1.
It takes 20 ascent steps with eta = 0.1. The final ratio must be between 1.19 and 1.3.
An unclipped update keeps increasing this ratio.
Clipping removes a sample's incentive to move farther. It gives no hard bound
on ratios after arbitrary parameter updates. The probe measures one controlled
batch with small steps. Its slight overshoot is expected.

## Check the checker

```bash
python3 labs/verify.py rl-sim --implementation labs/rl-sim/_solution/policy.py --output labs/rl-sim/work/reference-results.json
python3 labs/verify.py rl-sim --implementation labs/rl-sim/starter/policy.py --output labs/rl-sim/work/starter-results.json
python3 labs/verify.py rl-sim --implementation labs/rl-sim/_solution/buggy.py --output labs/rl-sim/work/buggy-results.json
```

The reference implements all seven functions. The starter raises TODO errors.
The buggy fixture removes PPO clipping. The objective and ratio checks explain
why that changes the update. Each failed run exits nonzero and still writes JSON.
Load errors report every public test ID as failed.
These small fixed tasks demonstrate policy gradients. Broader control tasks need
separate environments and evaluation.
