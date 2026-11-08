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
- **Explicit instruction for novices** (Kirschner, Sweller & Clark 2006): beginners learn faster when told what a thing is
  and shown how it works than when asked to discover it. So each new idea is defined first, then worked, then justified.
- **Advance organisers** (Ausubel 1960): a short overview of how new material connects to what you know makes it easier to
  learn. Hence the course introduction lesson, the "Where this fits" opening of every lesson and the week intros.
- **Learner feedback (decided with the user):** opening on a question or an invented scenario ("a housing app scores
  buyers") before saying what the thing is felt disordered. Lessons must read in the order: where this fits → what it is →
  how it works → why it is useful.

## Course order and running example
Week 1 runs in this order. Each lesson answers a need the previous lesson raised:

| # | Lesson | Previous lesson gave us | The gap this lesson fills |
|---|---|---|---|
| 1 | what-is-ml | (first lesson) | what ML is; the house-price problem; how the course connects to robots |
| 2 | supervised-learning | ML learns a rule from examples | names the parts: inputs, target, model, parameters, loss, dataset |
| 3 | vectors | a house's inputs are several numbers | a way to keep those numbers together in a fixed order |
| 4 | dot-product | a house is a vector | turning that vector into one price: a weighted total |
| 5 | matrices | one house → one price | pricing every house in one calculation |
| 6 | linear-regression | all the pieces of a prediction | the full model ŷ = w·x + b, for one house and for all of them |
| 7 | derivatives | a model whose weights we must choose | which way nudging one weight moves the loss, and how fast |
| 8 | loss-functions | slopes of a function | choosing how to score mistakes (MSE vs MAE) and how their slopes differ |
| 9 | partial-derivatives | the slope for one weight | real models have many weights: the slope for each, holding the others fixed |
| 10 | gradients | one partial derivative per weight | all of them as one vector: the direction the loss rises fastest |
| 11 | gradient-descent | the gradient | stepping the weights downhill repeatedly: training |
| 12 | train-test-split | a trained model with low training loss | checking it works on houses it has never seen |

Week 2: perceptron (yes/no decisions: does a house sell above its asking price?) → activation-functions (one neuron only
draws a straight line; stacked weighted totals collapse) → mlp-forward-pass (layers of neurons predict a house's price) →
chain-rule (training a network needs derivatives of a function inside a function) → computational-graphs (keeping the chain
rule organised for big calculations) → backpropagation (every gradient in one backward pass; then the Week 2 project).

**One running example.** Week 1 explanations and worked examples use the house-price model from the dot-product lesson:
$x = (12, 3, 20)$ (area in tens of m², bedrooms, age in years), $w = (25, 10, -1)$ in thousands of pounds per unit,
prediction 310 (thousand pounds). Week 2 continues with houses (sell above asking price; price from a small network).
Practice questions may use other settings (that tests transfer), but explanations must not invent a new scenario per lesson.
Robots get at most one or two sentences of payoff per lesson, in "Why this is useful".

## Required structure
1. **`where_this_fits`** (shown first, titled "Where this fits"), 30–90 words: name the previous lesson and what it gave
   us, say what we still can't do, and say that this lesson fills that gap. Only refer to lessons already taught, the next
   lesson, or the course introduction. No "you'll use this in attention" lists.
2. **Each knowledge point that introduces a new object** reads in this order, using bold lead-ins:
   - **What X is.** The general definition first, in one or two plain sentences that don't depend on the running example (say "examples", "values", "rows", not "houses"). Only then connect it to the house example.
   - **How it works** (or "How to compute it"). Step by step with small numbers, then *why the method works*
     (a picture or one-line reason; a diagram where shape matters).
   - **Why this is useful.** Tie it to the running example. Every knowledge point must contain a paragraph starting
     `**Why this is useful.**` (checked by `pnpm content:check`).
   A knowledge point about a property of an object already defined may open with the question it answers.
3. **"Why this way?"** whenever a reasonable alternative exists, say why we choose this one
   (squared vs absolute error, ReLU vs sigmoid, matrix product vs a loop, validation set vs reusing test).
4. **Worked example** starts "This example shows …", uses the running example where possible, and agrees with the explanation.
5. **Practice per knowledge point:** 4–6 problems; at least one why-question with diagnostic distractors.
6. **Summary** ends with a line starting `**Next:**`: the next lesson and the need it answers, in one sentence.
7. Limits (checked): `where_this_fits` 30–90 words; each `explain` at most 250 words (maths spans count as one word, code
   and SVG fences excluded).

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

## Writing style
- **Maths line by line.** When a passage computes or derives something, put each step on its own display line (`$$...$$` in its own paragraph, or one `\begin{aligned}` block with one `&=` step per line), with a short prose sentence before or after saying what the step does. Don't chain more than two equations inside one prose sentence. Inline maths is for naming a symbol or a single value (e.g. "the error $e=-20$").
- **Voice:** a teacher talking. Standard terms only, no coined phrases ("floor move", "housing app scores buyers");
  define every noun on first use; full sentences that build one step at a time; never "because the formula says so".
- **Order:** say what the thing is before asking questions about it. Don't open with an invented story.
- **No metaphors without a picture.** "Shadow" for projection failed: the learner didn't know what the shadow meant.
  Use the simplest concrete case first (e.g. $b=(1,0)$, where $a\cdot b$ is just how far $a$ goes right), back it with a
  diagram, then name the term.
- **One new symbol or term at a time.** If a paragraph introduces more than two new terms, split it or move one to the
  next knowledge point.

### Model opening (matrices)
> **Where this fits.** In the last lesson, the dot product turned one house's measurements into one predicted price. A real
> dataset has hundreds of houses, and writing out one dot product per house is slow and easy to get wrong. A matrix holds
> all the houses in one grid, so a single multiplication prices every house at once.
>
> **What a matrix is.** A matrix is a rectangular grid of numbers. A row runs across and a column runs down …
>
> **Multiplying a matrix by a vector.** Take each row, find its dot product with the vector, and stack the answers …
>
> **Why this is useful.** Put each house's measurements in one row and the model's weights in the vector. One
> multiplication then gives every house's predicted price …
