---

name: set-weights
description: "Set and independently review encompassing weights after a topic's questions are written. Use before shipping a course or after changing its questions or prerequisite steps."
---

# Setting encompassing weights

Math Academy's FIRe method (_The Math Academy Way_, chapter 29) gives review credit when an advanced topic practises a prerequisite. For topic C and prerequisite P, w(C,P) is the fraction of P practised when you solve C's problems. It ranges from 0 to 1. A weight of 0 is normal when C only needs familiarity with P.

## 1. Work out each weight

After C's questions are written, do this for each of its direct hard prerequisites and each prerequisite named in a lesson step's `key_prereqs`. Count a prerequisite once even if it appears in both places or in several steps.

1. A is every exercise owned by C except role `recall`. Use the exercise file's `concept:` field to find its owner.
2. S is the set of knowledge points (steps) in P's lesson.
3. Work through the full solution to every exercise a in A. List the steps of P that the learner has to perform: carry out the procedure or apply the fact. Recognising a term, reading a given value or using an idea as background does not count. For each exercise, e(a,P) is the number of required steps divided by the number of steps in S.
4. Take the mean of e(a,P) over A and round it to two decimal places, rounding halfway values up.

Save a uses YAML file for each batch, keyed by concept and then prerequisite. Record the total counts of exercises in A and steps in S. Give every exercise an entry, with an empty list when it requires no steps from P. For example:

```yaml
advanced-topic:
  earlier-topic:
    weight: 0.25
    exercises: 2
    steps: 2
    uses:
      advanced-problem-one: [earlier-step-one]
      advanced-problem-two: []
```

## 2. Check with a separate agent

Have a separate agent or session work through the same exercises and write its own uses file before it sees the writer's file. Then compare the files exercise by exercise. Decide each disagreement on the merits of the solution and recompute the weights from the agreed step lists.

Only after this check, write the decided weights in `content/concepts/*.yaml` as `encompassings: [{ id: earlier-topic, weight: 0.25 }]`. Keep entries whose weight is 0.

Before shipping, combine the decided batch files into one uses YAML file covering the whole pack and run `pnpm academy weights verify <uses.yaml> --pack <dir>`. It checks the edges, IDs, arithmetic and concept files. You can leave out topics with no non-recall exercises yet. If you include one of their edges, record weight 0 in both files. The separate review is what checks whether each solution actually uses the listed steps.
