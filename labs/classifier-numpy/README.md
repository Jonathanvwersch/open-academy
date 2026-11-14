# Classifier from scratch

Build logistic regression and softmax regression with NumPy. You write the probability functions, losses, gradients, updates and metrics. Data generation, splitting, reporting and file handling are provided.

## Setup

From the repository root:

```bash
python3 -m pip install -r labs/classifier-numpy/requirements.txt
python3 labs/classifier-numpy/setup.py
```

Edit `labs/classifier-numpy/work/classifier.py`. Setup preserves existing work. After installing NumPy, every command runs offline on a laptop CPU. The verifier takes a few seconds.

## Data and shapes

`make_data(classes=2, seed=17)` generates 200 examples per class from two-dimensional Gaussian blobs with spread 0.8. It shuffles with a fixed seed and returns `X_train, y_train, X_val, y_val`. The 80/20 split is already implemented. Use only the training split to update weights.

Each row of `X` is one example. Targets `y` have shape `(n,)`. Binary weights have shape `(d,)` and bias is a scalar. Multiclass weights have shape `(d, k)` and bias has shape `(k,)`. Scores are `X @ w + b`.

## Small steps

1. Implement `sigmoid(z)`. It returns probabilities with the input shape. Avoid overflow at large negative scores. One stable expression is `exp(-logaddexp(0, -z))`.
2. Implement `softmax(z)` for a batch of rows. Subtract the maximum within each row, exponentiate, then normalize within that row. Preserve shape `(n, k)`.
3. Implement `binary_loss_grad`. Return `(loss, dw, db)`. For scores `z`, compute mean binary cross-entropy as `mean(logaddexp(0, z) - y*z)`. With residual `r = sigmoid(z) - y`, the gradients are `X.T @ r / n` and `mean(r)`.
4. Implement `multiclass_loss_grad`. For shifted logits `s = z - z.max(axis=1, keepdims=True)`, loss is `mean(log(sum(exp(s), axis=1)) - s[arange(n), y])`. For the gradient, copy the softmax probabilities and subtract one in each row's target column. Return `X.T @ residual / n` and `mean(residual, axis=0)`. The loss is a scalar. Weight and bias gradients match their parameter shapes.
5. Implement `train(X, y, classes=2, lr=0.1, steps=600)`. Here `lr` is the learning rate. Initialize weights and bias to zeros. Select the binary objective for two classes and the multiclass objective for three. Each update subtracts learning rate times gradient. Return `(w, b, history)`, including the initial loss and the loss after each update. With zero steps, return zeros and one loss.
6. Implement `confusion_matrix(y, predicted, classes)`. Return a square integer count array. True labels index rows; predictions index columns. Empty arrays produce an all-zero matrix.
7. Implement `metrics(matrix)`. Accuracy is the diagonal sum divided by the total count. Per-class precision divides each diagonal entry by its column total. Per-class recall divides by its row total. Return `(accuracy, precision, recall)`, with the last two arrays of shape `(classes,)`. Define every zero-denominator result as zero, including accuracy on an empty matrix.

The public checks test each step separately. Loss and gradient checks use a small batch and central numerical differences. Repeating a batch must preserve a mean loss and its gradients. The softmax check includes scores near 1000 and -1000 and a common shift of 9000.

## Evaluate and submit

```bash
python3 labs/classifier-numpy/report.py
python3 labs/verify.py classifier-numpy
```

The reporting script trains both classifiers with learning rate 0.1 for 600 full-batch steps. It uses a threshold of 0.5 for binary probabilities and the largest probability for multiclass predictions. It prints the held-out confusion matrices, accuracy, precision and recall. Inspect which true classes are confused.

The verifier independently measures held-out accuracy. Both models must exceed 0.90. Upload `labs/classifier-numpy/work/results.json` on the project page. Failed checks include a message identifying the contract to revisit.

## Checker evidence

`_solution/classifier.py` is a complete reference. `_solution/buggy.py` swaps precision and recall, a mistake that equal class totals can hide. The asymmetric public matrix catches it in `test_precision_recall`. Use `--implementation PATH --output PATH` with the verifier to check another file without overwriting your work.
