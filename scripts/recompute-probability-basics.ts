import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { ExerciseSchema } from '../src/server/content/schemas.js';
import { instantiateExercise } from '../src/server/content/templates.js';

const source = parse(
  await readFile(new URL('../content/exercises/probability-basics.yaml', import.meta.url), 'utf8'),
) as { exercises: unknown[] };
const exercises = source.exercises.map((exercise) => ExerciseSchema.parse(exercise));
const byId = new Map(exercises.map((exercise) => [exercise.id, exercise]));

function close(actual: number, expected: number, label: string) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${label}: expected ${expected}, got ${actual}`);
}

const format = (value: number) => Number(value.toFixed(3)).toString();

function numericExercise(id: string) {
  const exercise = byId.get(id);
  assert.ok(exercise?.type === 'numeric' && 'answer' in exercise, `${id} must be fixed numeric`);
  return exercise;
}

function checkFixedAnswer(id: string, expected: number, wrongAnswers: number[]) {
  const exercise = numericExercise(id);
  close(exercise.answer, expected, `${id} correct answer`);
  assert.deepEqual(
    exercise.common_wrong?.map(({ answer }) => answer) ?? [],
    wrongAnswers,
    `${id} common-wrong answers`,
  );
  for (const wrong of wrongAnswers) assert.notEqual(wrong, expected, `${id} distractor`);
}

function checkTemplate(id: string, expectedFor: (params: Record<string, number>) => number) {
  const template = byId.get(id);
  assert.ok(
    template?.type === 'numeric' && 'answer_expr' in template,
    `${id} must be numeric template`,
  );
  const { exercise, params } = instantiateExercise(template, 0);
  assert.ok(exercise.type === 'numeric' && 'answer' in exercise);
  close(exercise.answer, expectedFor(params), `${id} instantiated answer`);
  return { answer: exercise.answer, params };
}

const aboveCount = 3;
const salesCount = 8;
const aboveProbability = aboveCount / salesCount;
const complementProbability = (salesCount - aboveCount) / salesCount;
close(aboveProbability, 0.375, 'above-asking frequency');
close(complementProbability, 0.625, 'complement frequency');
close(aboveProbability + complementProbability, 1, 'complement sum');

const complementQuestion = byId.get('pb-complement-why');
assert.ok(complementQuestion?.type === 'mc');
const optionValue = (text: string) => {
  const match = text.match(/\d+(?:\.\d+)?/);
  assert.ok(match, `expected a numeric answer in MC option: ${text}`);
  return Number(match[0]);
};
const correctComplementOption = complementQuestion.options.find((option) => option.correct);
assert.ok(correctComplementOption);
close(optionValue(correctComplementOption.text), complementProbability, 'complement MC answer');
for (const option of complementQuestion.options.filter(({ correct }) => !correct)) {
  assert.notEqual(optionValue(option.text), complementProbability, 'complement MC distractor');
}

const counts = [2, 3, 4, 1];
const possibleOffers = [0, 1, 2, 3];
const probabilities = counts.map((count) => count / 10);
close(
  probabilities.reduce((sum, probability) => sum + probability, 0),
  1,
  'distribution sum',
);
const weightedTerms = possibleOffers.map((offers, index) => offers * (probabilities[index] ?? 0));
const expectedOffers = weightedTerms.reduce((sum, value) => sum + value, 0);
const plainMean = possibleOffers.reduce((sum, offers) => sum + offers, 0) / possibleOffers.length;
close(expectedOffers, 1.4, 'expected offers');
close(plainMean, 1.5, 'plain mean of possible offer counts');

const aboveAndMany = 6;
const notAboveAndMany = 2;
const aboveAndFew = 3;
const notAboveAndFew = 9;
const manyOffersCount = aboveAndMany + notAboveAndMany;
const totalTableCount = manyOffersCount + aboveAndFew + notAboveAndFew;
const jointProbability = aboveAndMany / totalTableCount;
const manyOffersProbability = manyOffersCount / totalTableCount;
const conditionalProbability = aboveAndMany / manyOffersCount;
const overallAboveProbability = (aboveAndMany + aboveAndFew) / totalTableCount;
close(manyOffersCount, 8, 'at-least-two-offer row total');
close(aboveAndFew + notAboveAndFew, 12, 'fewer-than-two-offer row total');
close(totalTableCount, 20, 'house-sale table total');
close(aboveAndMany + aboveAndFew, 9, 'above-asking column total');
close(notAboveAndMany + notAboveAndFew, 11, 'not-above-asking column total');
close(jointProbability, 0.3, 'joint probability');
close(manyOffersProbability, 0.4, 'at-least-two-offer probability');
close(conditionalProbability, 0.75, 'conditional probability');
close(conditionalProbability * manyOffersProbability, jointProbability, 'product rule');
close(overallAboveProbability, 0.45, 'overall above-asking probability');
assert.notEqual(conditionalProbability, overallAboveProbability, 'independence check');

const independenceQuestion = byId.get('pb-independence-why');
assert.ok(independenceQuestion?.type === 'mc');
const independenceOptions = independenceQuestion.options;
const correctIndependenceOption = independenceOptions.find((option) => option.correct);
assert.ok(correctIndependenceOption);
const correctRates = correctIndependenceOption.text.match(/\d+(?:\.\d+)?/g)?.map(Number);
assert.deepEqual(correctRates, [conditionalProbability, overallAboveProbability]);
const swappedRates = independenceOptions
  .find(({ id }) => id === 'b')
  ?.text.match(/\d+(?:\.\d+)?/g)
  ?.map(Number);
assert.deepEqual(swappedRates, [overallAboveProbability, conditionalProbability]);
assert.ok(jointProbability < manyOffersProbability && jointProbability < overallAboveProbability);

checkFixedAnswer('pb-frequency-fixed', aboveProbability, [complementProbability, 3 / 5]);
checkFixedAnswer('pb-distribution-fixed', probabilities[2] ?? 0, [
  probabilities[0] ?? 0,
  probabilities[1] ?? 0,
]);
checkFixedAnswer('pb-expectation-fixed', expectedOffers, [plainMean, 2]);
checkFixedAnswer('pb-conditional-fixed', conditionalProbability, [
  jointProbability,
  overallAboveProbability,
]);

const frequencyTemplate = checkTemplate(
  'pb-frequency-template',
  ({ above, other }) => above / (above + other),
);
const distributionTemplate = checkTemplate(
  'pb-distribution-template',
  ({ zero_count, one_count, two_count, three_count }) =>
    two_count / (zero_count + one_count + two_count + three_count),
);
const expectationTemplate = checkTemplate(
  'pb-expectation-template',
  ({ count0, count1, count2, count3 }) =>
    (count1 + 2 * count2 + 3 * count3) / (count0 + count1 + count2 + count3),
);
const conditionalTemplate = checkTemplate(
  'pb-conditional-template',
  ({ above_and_many: above, not_above_and_many: notAbove }) => above / (above + notAbove),
);

console.log(
  `Above asking: ${aboveCount}/${salesCount} = ${format(aboveProbability)}; complement: ${salesCount - aboveCount}/${salesCount} = ${format(complementProbability)}; sum = 1.`,
);
console.log(
  `Offer distribution: ${probabilities.map(format).join(', ')} (sum 1); weighted terms: ${weightedTerms.map(format).join(', ')}; expectation = ${format(expectedOffers)}, plain mean = ${format(plainMean)}.`,
);
console.log(
  `Sales table: rows 8 and 12, columns 9 and 11, total 20; joint = ${format(jointProbability)}, P(B) = ${format(manyOffersProbability)}, P(A|B) = ${format(conditionalProbability)}, product = ${format(conditionalProbability * manyOffersProbability)}, P(A) = ${format(overallAboveProbability)}.`,
);
console.log(
  `Verified fixed-answer distractors: frequency [${[complementProbability, 3 / 5].map(format).join(', ')}], distribution [${probabilities.slice(0, 2).map(format).join(', ')}], expectation [${format(plainMean)}, 2], conditional [${format(jointProbability)}, ${format(overallAboveProbability)}].`,
);
console.log(
  `Verified template instances: ${format(frequencyTemplate.answer)} (${JSON.stringify(frequencyTemplate.params)}), ${format(distributionTemplate.answer)} (${JSON.stringify(distributionTemplate.params)}), ${format(expectationTemplate.answer)} (${JSON.stringify(expectationTemplate.params)}), ${format(conditionalTemplate.answer)} (${JSON.stringify(conditionalTemplate.params)}).`,
);
console.log(
  `Verified complement MC distractors: ${complementQuestion.options
    .filter(({ correct }) => !correct)
    .map(({ text }) => format(optionValue(text)))
    .join(', ')}; all differ from ${format(complementProbability)}.`,
);
console.log('All probability arithmetic checks passed.');
