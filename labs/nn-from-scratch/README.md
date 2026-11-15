# Neural network and backpropagation from scratch

In this project, we will build a small classifier that learns a curved boundary. The data contains two interleaved moons, so a single straight line cannot separate the classes well. One hidden layer gives the model the flexibility it needs; a hand-written backward pass gives us a way to see how each parameter learns.

## Setup

From the repository root, install NumPy and copy the starter into your work directory:

```bash
python3 -m pip install -r labs/nn-from-scratch/requirements.txt
python3 labs/nn-from-scratch/setup.py
```

Edit `labs/nn-from-scratch/work/nn.py`. The starter already contains a fixed-seed data generator and train/validation split. It creates 600 noisy, two-dimensional examples. The first 480 are for training; the remaining 120 are for validation.

Running setup again keeps your existing implementation. Pass `--force` only when you
want to replace it with the starter.

## The network

Each row of `X` is one example. Each row of `W1` stores one hidden neuron's weights, and each row of `W2` stores one output neuron's weights. For a batch of `m` examples, use:

```text
Z1 = X @ W1.T + b1
H  = ReLU(Z1)
Z2 = H @ W2.T + b2
y_hat = sigmoid(Z2)
```

For this project, `W1` has shape `(n_hidden, n_in)`, `b1` has shape `(n_hidden,)`, `W2` has shape `(1, n_hidden)`, and `b2` has shape `(1,)`. The predictions and targets each have shape `(m, 1)`.

## Tasks

### 1. Initialize the parameters

Implement `init_params(n_in, n_hidden, n_out, seed)`. Return a dictionary with `W1`, `b1`, `W2`, and `b2`. Different hidden neurons need different initial weights so they can learn different features. Start with `rng = np.random.default_rng(seed)`. Draw `W1` first with shape `(n_hidden, n_in)` from a normal distribution with variance `2/n_in`, using `rng.normal(0, np.sqrt(2/n_in), size=(n_hidden, n_in))`. Then draw `W2` with shape `(n_out, n_hidden)` from variance `1/n_hidden`, using `rng.normal(0, np.sqrt(1/n_hidden), size=(n_out, n_hidden))`. Set both biases to zero.

### 2. Make a prediction

Implement `forward(params, X)`. Calculate `Z1` and `H`, then `Z2` and `y_hat`. ReLU is `max(0, z)` and sigmoid is `1 / (1 + exp(-z))`. Return both `y_hat` and a cache containing `X`, `Z1`, `H`, and `y_hat`; the backward pass will use those saved values.

### 3. Measure the error

Implement `loss(y_hat, y)` as mean binary cross-entropy:

```text
L = -mean(y * log(y_hat) + (1 - y) * log(1 - y_hat))
```

Clip probabilities to a small interval inside `(0, 1)` before taking logarithms. This keeps the loss finite when a prediction is very close to zero or one.

### 4. Send the loss slope backwards

For sigmoid output with binary cross-entropy, the output-logit derivative simplifies to:

```text
dZ2 = (y_hat - y) / m
dW2 = dZ2.T @ H
db2 = sum(dZ2, axis=0)
dH  = dZ2 @ W2
dZ1 = dH * (Z1 > 0)
dW1 = dZ1.T @ X
db1 = sum(dZ1, axis=0)
```

Here `m` is the number of examples in the batch. The indicator `(Z1 > 0)` is the ReLU derivative. Return a gradient dictionary with the same keys and shapes as the parameter dictionary.

### 5. Check the gradients

Implement `numerical_grad(f, params, eps)` using the central difference for each parameter:

```text
(f(params + eps) - f(params - eps)) / (2 * eps)
```

Only the selected parameter changes in each pair of evaluations. A moderate `eps` gives a useful check: if it is too large, curvature affects the estimate; if it is too small, floating-point rounding can overwhelm the change.

### 6. Train and evaluate

Implement `train(params, X, y, lr, steps)` with full-batch gradient descent. On each step, calculate the gradients and update each parameter with `parameter -= lr * gradient`. Update the supplied parameter arrays and return the loss history, including the loss after the last update. Implement `accuracy(y_hat, y)` using a probability threshold of `0.5`.

Use a hidden width of `32`, learning rate `0.2`, `4000` steps, and initialization seed `7` as a reliable starting point. Train only on the training split and report accuracy on the validation split. The verifier also fits a logistic-regression baseline directly to the two input features.

## Run the verifier

After you implement the functions, run:

```bash
python3 labs/verify.py nn-from-scratch
```

The verifier writes `labs/nn-from-scratch/work/results.json`. It checks the array shapes, a small forward-pass reference, the mean loss, the backward pass against numerical gradients, a loss-lowering update, validation accuracy, and the linear baseline. It also reports final training loss, validation accuracy, and the largest relative gradient-check error.

## Common bugs

- **Using the wrong transpose:** examples are rows, while neurons are rows of `W1` and `W2`. The forward products therefore use `W1.T` and `W2.T`.
- **Forgetting to average over the batch:** divide the output derivative by `m` once. The weight-matrix products already add contributions across examples.
- **Using the wrong update sign:** gradient descent subtracts the gradient. Adding it usually moves the parameters uphill and increases the loss.
- **Comparing incompatible shapes:** keep targets and predictions as `(m, 1)` arrays, and return each bias gradient with the same one-dimensional shape as its bias.
- **Initializing every hidden neuron identically:** identical hidden units receive identical updates and cannot specialize. Use a seeded random initialization instead.
