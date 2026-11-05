# Lesson standard: teach the why, not just the what

Every lesson must answer three questions before it teaches a formula:
**what problem forces this idea to exist, what goes wrong without it, and what it lets you do next.**
Example of the bar: "A Fourier transform converts time to frequency" is not enough. The lesson must first show why
we'd want frequencies (e.g. a hum in a recording is invisible in the waveform but is one spike in frequency, so you can delete it).

## Evidence this is built on
- **Necessity principle** (Harel, DNR): learners only learn what they feel an intellectual need for. Present the problem
  the concept solves before the concept; "this is needed to factor A = XDX⁻¹" is a need only the teacher feels.
- **Problem before instruction** (Sinha & Kapur 2021 meta-analysis, 53 studies: g = 0.36, up to 0.58 done well):
  meeting the problem and seeing your obvious approach fall short, then getting the explanation, beats explanation first.
- **Elaborative interrogation** (Dunlosky et al.; Learning Scientists): asking and answering "why does this work / why this
  and not that" improves understanding and transfer. So practice must include why-questions, not only computation.
- **Worked examples, minimum effective dose, mastery, spacing, interleaving** (Math Academy Way; Sweller): short
  explanation → full worked example → problems within minutes; 2 right in a row; FSRS reviews. Keep all of this.
- **Concrete examples + dual coding**: one running example with real numbers, plus a diagram where shape matters.

## Required structure
1. **`why` card (new field, shown first, titled "Why this exists")**, 60–140 words:
   - the concrete ML/robotics situation that needs this idea (a model, a robot, a dataset — not an abstract puzzle);
   - the obvious thing you'd try without it, and why it fails or doesn't scale;
   - what the idea lets you do, and which later course topics depend on it (by name).
2. **Each knowledge point** follows: question → obvious attempt and why it falls short → the idea → *why it works*
   (intuition or picture) → worked example ("This example shows …") → problems. The "why it works" sentence is mandatory.
3. **"Why this way?"** whenever a reasonable alternative exists, say why we choose this one
   (squared vs absolute error, ReLU vs sigmoid, L2 vs L1, matrix product vs a loop, validation set vs reusing test).
4. **Practice per knowledge point:** keep 4–6 problems; at least **one why-question** (MC with diagnostic distractors:
   "Why does …", "What goes wrong if …", "Why not just …"). Distractors are real misconceptions with feedback.
5. **Summary** ends with one line "**Where you'll use this:**" naming the later topics/robotics uses.
6. Maths lessons (vectors, dot product, matrices, derivatives, partials, gradients, chain rule) must tie their running
   example to ML within the `why` card and the last knowledge point, even if the running example is physical (car, valley).

## Audit of the current 17 lessons
- Good already: each knowledge point opens with a question; backprop, train/test split, activation functions, loss
  functions explain why well.
- Gap 1: the maths lessons answer a local puzzle (car speed, valley, floor grid) but never say why ML needs the idea
  (vectors never says every house/image/robot state *is* a vector; derivatives never says "which way to turn a weight").
- Gap 2: supervised learning opens with a definition, not a problem.
- Gap 3: "why this way" is rare (why L2 length, why ReLU is the default, why matrices instead of loops).
- Gap 4: practice is almost all computation: by keyword count ~19 of 325 problems ask why.

## Reference material per lesson (for writers; do not copy text)
- vectors, dot-product, matrices: 3Blue1Brown *Essence of linear algebra* (ch1 vectors, ch3 matrices as transformations,
  ch9 dot products and duality); Deisenroth et al. *Mathematics for Machine Learning* ch2–3.
- derivatives, chain-rule: 3Blue1Brown *Essence of calculus* (ch2 paradox of the derivative, ch4 chain rule);
  partial-derivatives, gradients: Khan Academy multivariable calculus (partial derivatives, gradient and directional derivative).
- supervised-learning, linear-regression, loss-functions, gradient-descent, train-test-split: Google ML Crash Course
  (linear regression, loss, gradient descent, datasets/generalization); d2l.ai ch3.
- perceptron, activation-functions, mlp-forward-pass: Nielsen *Neural Networks and Deep Learning* ch1; 3Blue1Brown
  *Neural networks* ch1; d2l.ai ch5 (MLP, activation functions).
- computational-graphs, backpropagation: Karpathy *micrograd* lecture; Nielsen ch2 ("In what sense is backpropagation
  a fast algorithm?"); 3Blue1Brown *Neural networks* ch3–4.
