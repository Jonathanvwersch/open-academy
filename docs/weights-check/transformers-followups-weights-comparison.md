# Transformers/LLMs encompassing weights: blind pass vs. committed draft

- Blind YAML: `/home/ubuntu/transformers-followups-blind-weights.yaml`. Frozen before opening the draft; recommendations below do not overwrite it.
- Draft: `docs/transformers-followups-weights-draft.yaml` at `8f7ba2a47aad67c915791584f149b8ff6554b61c`.
- Compared six owners, 29 edges, and 174 distinct non-recall exercises (including diagnostics, project, lesson-only, template, and explain exercises). Found 53 exercise/edge step-set disagreements. No missing/extra edges or exercise IDs, invalid step IDs, or arithmetic discrepancies in either file.
- Denominator: owner exercise count × prerequisite knowledge-point count. Weights are half-up to two decimals. Steps are counted once per exercise per edge.
- Recommendations are independent adjudications for the lead to reconcile; this is not a full-pack verification and no concept files were changed.

## Borderline calls

- **Aliases vs. operations.** Naming softmax, selecting its score row, and picking which already-described inputs enter a dot helper do not practice softmax or dot-product arithmetic. An explanation may still count when its rubric requires applying a property (e.g. normalization).
- **One coordinate still counts.** Computing a single component of a genuine weighted mix applies the scale/add steps; writing its matched scalar products can also exercise a dot product when that prerequisite is an edge. A worked example that supplies a single needed contribution does not require recomputing a dot product or its softmax weight.
- **PPO and policy-gradient boundaries.** The baseline-adjusted update is covered by pg-baseline; the wider REINFORCE derivation isn't used in that problem. Zero advantages do not force the learner to apply PPO clipping.
- **Normalization boundaries.** Mean/spread and one gain/shift per entry apply LayerNorm; deciding where to call a supplied normalization function is a block-layout skill. Renormalizing already-given top-k probabilities in MoE is not the same prerequisite operation as converting raw scores with softmax.
- **Counting parameters vs. forward passes.** Deriving projection shapes and bias counts applies the related counting steps; no MLP activations or attention activation tensors need to be computed. The transformer-block MLP count can apply to an MoE expert even without the rest of a block.
- **Explain rubrics.** Required rubric criteria count even when the exemplar is abbreviated. Optional details or facts that simply support the setting do not count.

## Counts and weights

| Owner | Prerequisite | Exercises | Steps | Blind tags / weight | Draft tags / weight | Recommended tags / weight |
|---|---|---:|---:|---:|---:|---:|
| rl-verifiable-rewards | sft | 33 | 2 | 1 / 0.02 | 2 / 0.03 | 1 / 0.02 |
| rl-verifiable-rewards | policy-gradients | 33 | 4 | 8 / 0.06 | 10 / 0.08 | 8 / 0.06 |
| rl-verifiable-rewards | rlhf | 33 | 4 | 4 / 0.03 | 6 / 0.05 | 4 / 0.03 |
| rl-verifiable-rewards | descriptive-statistics | 33 | 4 | 9 / 0.07 | 8 / 0.06 | 9 / 0.07 |
| rl-verifiable-rewards | ppo | 33 | 4 | 5 / 0.04 | 7 / 0.05 | 5 / 0.04 |
| attention | embeddings | 27 | 3 | 0 / 0.00 | 0 / 0.00 | 0 / 0.00 |
| attention | dot-product | 27 | 3 | 12 / 0.15 | 7 / 0.09 | 11 / 0.14 |
| attention | classification-softmax | 27 | 3 | 10 / 0.12 | 11 / 0.14 | 9 / 0.11 |
| attention | vectors | 27 | 3 | 22 / 0.27 | 20 / 0.25 | 22 / 0.27 |
| transformer-block | multi-head-attention | 39 | 3 | 7 / 0.06 | 8 / 0.07 | 7 / 0.06 |
| transformer-block | positional-encoding | 39 | 3 | 0 / 0.00 | 0 / 0.00 | 0 / 0.00 |
| transformer-block | weight-init-normalization | 39 | 4 | 9 / 0.06 | 9 / 0.06 | 9 / 0.06 |
| transformer-block | mlp-forward-pass | 39 | 3 | 7 / 0.06 | 14 / 0.12 | 8 / 0.07 |
| transformer-block | activation-functions | 39 | 3 | 2 / 0.02 | 3 / 0.03 | 2 / 0.02 |
| transformer-block | attention | 39 | 3 | 3 / 0.03 | 4 / 0.03 | 3 / 0.03 |
| transformer-block | chain-rule | 39 | 3 | 4 / 0.03 | 4 / 0.03 | 4 / 0.03 |
| transformer-block | vectors | 39 | 3 | 11 / 0.09 | 10 / 0.09 | 10 / 0.09 |
| causal-masking | attention | 22 | 3 | 16 / 0.24 | 15 / 0.23 | 16 / 0.24 |
| causal-masking | classification-softmax | 22 | 3 | 11 / 0.17 | 11 / 0.17 | 11 / 0.17 |
| causal-masking | matrices | 22 | 2 | 2 / 0.05 | 3 / 0.07 | 2 / 0.05 |
| autoregressive-lm | causal-masking | 32 | 2 | 1 / 0.02 | 1 / 0.02 | 1 / 0.02 |
| autoregressive-lm | transformer-block | 32 | 4 | 0 / 0.00 | 0 / 0.00 | 0 / 0.00 |
| autoregressive-lm | classification-softmax | 32 | 3 | 9 / 0.09 | 10 / 0.10 | 9 / 0.09 |
| autoregressive-lm | probability-basics | 32 | 4 | 15 / 0.12 | 11 / 0.09 | 15 / 0.12 |
| mixture-of-experts | transformer-block | 21 | 4 | 1 / 0.01 | 1 / 0.01 | 1 / 0.01 |
| mixture-of-experts | classification-softmax | 21 | 3 | 0 / 0.00 | 0 / 0.00 | 0 / 0.00 |
| mixture-of-experts | matrices | 21 | 2 | 5 / 0.12 | 5 / 0.12 | 5 / 0.12 |
| mixture-of-experts | mlp-forward-pass | 21 | 3 | 1 / 0.02 | 2 / 0.03 | 1 / 0.02 |
| mixture-of-experts | vectors | 21 | 3 | 4 / 0.06 | 2 / 0.03 | 4 / 0.06 |

## Every disagreement

## rl-verifiable-rewards

### sft

| Exercise | Blind | Committed draft | Recommended | Why |
|---|---|---|---|---|
| `rlvr4-kl-reason` | `[]` | `[sft-example-responses]` | `[]` | The KL rationale works for any frozen reference. The solution mentions SFT only as a common choice; training on example responses or using their effects is unnecessary. |

### policy-gradients

| Exercise | Blind | Committed draft | Recommended | Why |
|---|---|---|---|---|
| `rlvr-group-advantage-basics` | `[]` | `[pg-baseline]` | `[]` | This identifies GRPO's choice of baseline. It neither compares a concrete reward with that baseline nor performs a baseline-adjusted update. |
| `rlvr3-reinforce-step` | `[pg-baseline]` | `[pg-reinforce, pg-baseline]` | `[pg-baseline]` | The required update is the baseline-adjusted rule from pg-baseline with a replacement for G−b: 0 + 0.1 × 2 × 0.5 = 0.1. The prerequisite's separate trajectory-probability argument and unadjusted whole-episode return weighting are not performed. |

### rlhf

| Exercise | Blind | Committed draft | Recommended | Why |
|---|---|---|---|---|
| `rlvr4-kl-reason` | `[rlhf-kl-reward]` | `[rlhf-kl-reward, rlhf-pipeline]` | `[rlhf-kl-reward]` | Explaining that the penalty limits drift applies the reference-policy purpose; it does not require the SFT, preference-model and PPO stages. |
| `rlvr-explain-training` | `[]` | `[rlhf-pipeline]` | `[]` | The rubric requires the checker, group advantage and why a direct checker suffices. It does not ask for any RLHF training stage or how a learned reward model is constructed or used in RLHF. |

### descriptive-statistics

| Exercise | Blind | Committed draft | Recommended | Why |
|---|---|---|---|---|
| `rlvr4-never-correct` | `[ds-centre-spread]` | `[]` | `[ds-centre-spread]` | Reasoning from all failed replies to all-zero advantages uses the fact that their group mean is zero and their spread is zero. This is the same all-equal case as rlvr3-all-same. |

### ppo

| Exercise | Blind | Committed draft | Recommended | Why |
|---|---|---|---|---|
| `rlvr3-all-same` | `[]` | `[ppo-clip]` | `[]` | A zero advantage kills the reward push regardless of the ratio or whether it is clipped; there is no clipping decision or comparison of clipped and unclipped terms. |
| `rlvr4-never-correct` | `[]` | `[ppo-clip]` | `[]` | All failures give zero advantages, so the reward contribution vanishes before clipping can make any difference. The question asks why initial successful replies matter, not how PPO clips a change. |

## attention

### dot-product

| Exercise | Blind | Committed draft | Recommended | Why |
|---|---|---|---|---|
| `attn-mix-reason` | `[dot-weighted-total]` | `[]` | `[]` | The worked example already displays each weighted contribution. The learner must connect cat's positive contribution to the second component; no new matched weighted total is necessary. |
| `attn-mix-faded` | `[dot-weighted-total]` | `[]` | `[dot-weighted-total]` | The second output coordinate is the dot product of (0.25, 0.75) and (0, 8): a matched weighted total, even though one product is zero. |
| `attn-mix-template` | `[dot-weighted-total]` | `[]` | `[dot-weighted-total]` | The unknown coordinate is the sum of two matched source-weight × source-component products; dot-weighted-total teaches that calculation even when the vectors are arranged by source. |
| `attn-mix-transfer` | `[dot-weighted-total]` | `[]` | `[dot-weighted-total]` | The result 5 requires the weighted total of the second-coordinate list (0, 10, 4) with (0.2, 0.3, 0.5). |
| `attn-recover-weight` | `[dot-weighted-total]` | `[]` | `[dot-weighted-total]` | The learner must set up 2(1−w)+10w=8 before solving. This is a matched weighted total with an unknown weight rather than an unknown total. |
| `attn-code-query-pair` | `[]` | `[dot-weighted-total]` | `[]` | Every option supplies the same dot helper and scale. The choice is which token roles supply its inputs (query at t and key at j), not how a dot product combines vector components. |
| `attn-code-value-array` | `[dot-weighted-total]` | `[]` | `[dot-weighted-total]` | Choosing the correct expression requires matching the row-2 weights to the corresponding first value components and adding their products, not merely identifying a dot-product term by name. |

### classification-softmax

| Exercise | Blind | Committed draft | Recommended | Why |
|---|---|---|---|---|
| `attn-weight-basics` | `[]` | `[sm-softmax]` | `[]` | The required option names softmax and its attention-specific axis; neither normalization nor any property of the resulting weights is needed to make that selection. |
| `attn-mix-reason` | `[sm-softmax]` | `[]` | `[]` | The example supplies cat's positive weight and its nonzero weighted second component. Explaining the contribution does not require computing the weight or invoking softmax positivity. |
| `attn-code-softmax-axis` | `[]` | `[sm-softmax]` | `[]` | This selects the pine row as the supplied inputs to softmax. It does not apply the score-to-weight transform or use a property of its outputs. |

### vectors

| Exercise | Blind | Committed draft | Recommended | Why |
|---|---|---|---|---|
| `attn-recover-weight` | `[vec-points-moves, vec-change-move]` | `[]` | `[vec-points-moves, vec-change-move]` | Setting up the weighted mixture scales both one-component values and adds them. The inverse solve does not remove these prerequisites from the setup. |

## transformer-block

### multi-head-attention

| Exercise | Blind | Committed draft | Recommended | Why |
|---|---|---|---|---|
| `tbp-stack-count-template` | `[mha-heads, mha-combine]` | `[mha-combine, mha-shapes]` | `[mha-heads, mha-combine]` | Deriving 4d²+4d for attention uses the three sets of head-specific projections and the output projection. No per-token query/key/value or score-grid tensor is shaped. |
| `tbp-stack-mlp-share` | `[mha-heads, mha-combine]` | `[mha-combine, mha-shapes]` | `[mha-heads, mha-combine]` | The denominator needs the weight counts for the head projections and the combined-output projection; it does not depend on any intermediate activation tensor shape. |
| `tbp-stack-heads-count` | `[mha-heads]` | `[mha-heads, mha-shapes]` | `[mha-heads]` | The six independent d × dₖ query weight matrices come straight from mha-heads. Counting their entries does not track the query array over T tokens. |
| `tbp-stack-robot` | `[mha-heads, mha-combine]` | `[mha-combine, mha-shapes]` | `[mha-heads, mha-combine]` | Each block's parameter count includes Q/K/V head projections and the output projection. The ten tokens do not affect stored weights; tracking batched activation shapes is unnecessary. |

### mlp-forward-pass

| Exercise | Blind | Committed draft | Recommended | Why |
|---|---|---|---|---|
| `tbp-sublayers-which-mixes` | `[]` | `[mlp-shapes]` | `[mlp-shapes]` | The MLP distractor explicitly equates applying the same weights with mixing tokens. Ruling it out applies the mlp-shapes fact that each row stays independent despite shared weights. |
| `tbp-stack-count-template` | `[mlp-shapes]` | `[mlp-layer-of-neurons, mlp-two-layers, mlp-shapes]` | `[mlp-shapes]` | The MLP count is (4d²+4d)+(4d²+d), the per-layer parameter-count rule in mlp-shapes. Neither a neuron score/activation nor a layer's forward output is computed. |
| `tbp-stack-mlp-share` | `[mlp-shapes]` | `[mlp-layer-of-neurons, mlp-two-layers, mlp-shapes]` | `[mlp-shapes]` | Counting 8d² MLP weights uses input width × output width for each matrix (biases excluded). It does not exercise computing neuron outputs or the sequential forward pass. |
| `tbp-stack-robot` | `[mlp-shapes]` | `[mlp-layer-of-neurons, mlp-two-layers, mlp-shapes]` | `[mlp-shapes]` | The robot problem repeats the same MLP parameter count for each block; it never runs a neuron or feeds computed hidden values into a second layer. |

### activation-functions

| Exercise | Blind | Committed draft | Recommended | Why |
|---|---|---|---|---|
| `tbp-sublayers-robot` | `[]` | `[act-relu-sigmoid-tanh]` | `[]` | The MLP explicitly returns max expressions, and only the first already-positive coordinate is needed. Evaluating the supplied max does not require knowing which activation implements that rule. |

### attention

| Exercise | Blind | Committed draft | Recommended | Why |
|---|---|---|---|---|
| `tb-explain-block` | `[]` | `[attn-mix-values]` | `[]` | The required attention criterion is only that it lets tokens share information. Neither paired weights and values nor the weighted-sum mechanism must be described. |

### chain-rule

| Exercise | Blind | Committed draft | Recommended | Why |
|---|---|---|---|---|
| `tbp-residual-slope-template` | `[cr-rates-multiply, cr-two-routes]` | `[cr-rates-multiply]` | `[cr-rates-multiply, cr-two-routes]` | Each layer first adds the shortcut slope 1 and sublayer slope a, then the stack multiplies the resulting slopes. Both route addition and serial multiplication are needed. |
| `tbp-prenorm-post-vs-pre` | `[cr-rates-multiply]` | `[cr-rates-multiply, cr-two-routes]` | `[cr-rates-multiply]` | Compare the factors along the shortcut route: post-norm inserts a LayerNorm derivative; pre-norm does not. The comparison need not sum shortcut and learned-branch derivatives. |

### vectors

| Exercise | Blind | Committed draft | Recommended | Why |
|---|---|---|---|---|
| `tb-explain-block` | `[vec-points-moves]` | `[]` | `[]` | The rubric wants the architectural fact about which tensors the shortcut adds; it does not require explaining matching components or performing the addition. |

## causal-masking

### attention

| Exercise | Blind | Committed draft | Recommended | Why |
|---|---|---|---|---|
| `lab-char-transformer-mask-leak` | `[attn-make-weights, attn-mix-values]` | `[attn-make-weights]` | `[attn-make-weights, attn-mix-values]` | The rubric requires showing both that masking before normalization restores the weight total and that the output then depends only on allowed values. The latter uses zero coefficients in the value mixture. |
| `cm-hide-diagonal` | `[attn-make-weights]` | `[]` | `[attn-make-weights]` | It is not enough to find that the first row has no allowed entries. The keyed answer also says its weights cannot be formed: no source survives to supply any positive softmax mass. |
| `cm-zero-last-row` | `[]` | `[attn-make-weights]` | `[]` | All mask offsets in the last row are zero; same scores give the same result without applying the score-to-weight calculation or one of its substantive properties. |
| `cm-zero-after-softmax` | `[attn-make-weights, attn-mix-values]` | `[attn-make-weights]` | `[attn-make-weights, attn-mix-values]` | The key says the output is shrunk, not just that its row sums to 0.31. Inferring the shrinkage applies the value mix: every remaining coefficient is smaller by the same factor than with proper renormalization. |
| `cm-code-block-predicate` | `[]` | `[attn-score-matches]` | `[]` | The code chooses blocked indices j>t after scores already exist; query–key scoring never enters the predicate. |

### classification-softmax

| Exercise | Blind | Committed draft | Recommended | Why |
|---|---|---|---|---|
| `cm-hide-diagonal` | `[sm-softmax]` | `[]` | `[sm-softmax]` | All blocked means an all-zero exponentiated row and hence a zero denominator, so no normalized result exists. |
| `cm-zero-last-row` | `[]` | `[sm-softmax]` | `[]` | The mask adds zero to each score. Equal inputs imply unchanged outputs without computing or reasoning about the softmax distribution itself. |

### matrices

| Exercise | Blind | Committed draft | Recommended | Why |
|---|---|---|---|---|
| `cm-hide-count-template` | `[]` | `[mat-rows-shapes]` | `[]` | The exercise asks for allowed ordered pairs. Counting 1+⋯+T from j≤t solves it without constructing a matrix or using its shape. |
| `cm-explain` | `[mat-rows-shapes]` | `[]` | `[mat-rows-shapes]` | Constructing the rubric's T × T array, with one query per row and one source per column and the diagonal positioned accordingly, applies row/column shape rather than just mentioning a grid. |
| `cm-code-block-predicate` | `[]` | `[mat-rows-shapes]` | `[]` | The prompt gives the axes and indexing conventions. The work is comparing the two sequence indices against the causal rule, not finding a matrix dimension or doing a matrix operation. |

## autoregressive-lm

### classification-softmax

| Exercise | Blind | Committed draft | Recommended | Why |
|---|---|---|---|---|
| `alm-next-basics` | `[]` | `[sm-softmax]` | `[]` | A next-token distribution describes the model's output, and the keyed option never asks how to produce it from logits. |

### probability-basics

| Exercise | Blind | Committed draft | Recommended | Why |
|---|---|---|---|---|
| `alm-next-self-explain` | `[pb-distributions]` | `[]` | `[pb-distributions]` | Explaining why the total is the divisor applies the distribution fact that mutually exclusive next-token chances must sum to 1, not just the fact that the algorithm happens to divide. |
| `alm-next-count` | `[pb-distributions]` | `[]` | `[pb-distributions]` | Equal scores produce equal shares, and the distribution axiom determines their common value via 5p=1. The two steps are distinct in the solution. |
| `alm-next-robot` | `[pb-distributions]` | `[]` | `[pb-distributions]` | Counting 4 × 1000 uses the fact that a distribution has one entry per possible outcome, once for each prediction position. |
| `alm-gen-drift` | `[pb-conditional]` | `[]` | `[pb-conditional]` | The reason the first error can change later probabilities is that the mistaken token changes the known prefix on which every later prediction is conditioned. Merely appending it would not explain the changed probabilities. |

## mixture-of-experts

### transformer-block

| Exercise | Blind | Committed draft | Recommended | Why |
|---|---|---|---|---|
| `moe-route-all` | `[]` | `[tb-two-sublayers]` | `[]` | Setting k=n removes expert skipping; the keyed result follows from the routing rule without running or comparing the two transformer block sublayers. |
| `moe-count-total` | `[tb-stack]` | `[]` | `[tb-stack]` | A two-layer width-preserving expert reuses the MLP parameter-counting part of tb-stack: count both projections and both bias vectors before summing experts. |

### matrices

| Exercise | Blind | Committed draft | Recommended | Why |
|---|---|---|---|---|
| `moe-count-why-router` | `[]` | `[mat-rows-shapes]` | `[]` | The eight router parameters are supplied. Explaining why they are all active needs the fact that all experts are scored before selection, not derivation of the shape or parameter count. |
| `moe-explain` | `[mat-rows-shapes]` | `[]` | `[mat-rows-shapes]` | The required count criterion includes deriving the bias-free router contribution nd: n output rows with d input weights per row. The short exemplar omits the formula, but the required rubric controls. |

### mlp-forward-pass

| Exercise | Blind | Committed draft | Recommended | Why |
|---|---|---|---|---|
| `moe-count-total` | `[mlp-shapes]` | `[mlp-layer-of-neurons, mlp-two-layers]` | `[mlp-shapes]` | mlp-shapes explicitly teaches counting a layer's weight and bias entries. The problem supplies the sequence of widths and does not require computing neuron scores or performing a forward pass. |

### vectors

| Exercise | Blind | Committed draft | Recommended | Why |
|---|---|---|---|---|
| `moe-route-rescaled-output` | `[vec-points-moves, vec-change-move]` | `[]` | `[vec-points-moves, vec-change-move]` | After keeping experts 2 and 3, the result scales their one-component outputs by normalized weights and adds the terms. This is the same vector operation as moe-route-output. |
