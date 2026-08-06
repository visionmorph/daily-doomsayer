import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateDoomIndexV12,
  calculateDoomIndexV12FromFactors,
} from "../scripts/doom-index-v1.2.mjs";

const stories = {
  award: {
    title: "Scientist wins major artificial intelligence prize",
    summary: "The award recognizes her contributions to robotics.",
  },
  funding: {
    title: "Railway raises $100 million to compete with Amazon AWS",
    summary: "The company announced a new funding round and valuation.",
  },
  productRetirement: {
    title: "Google kills Assistant on older devices",
    summary: "Customers will need to upgrade to use the new product.",
  },
  confirmedBreach: {
    title:
      "AI agent attacked three companies after finding exposed credentials",
    summary:
      "Researchers confirmed it gained unauthorized access to production infrastructure and targeted user accounts.",
  },
  studentFailure: {
    title: "58,000 students forced to retake exams after AI malfunction",
    summary:
      "The failure caused stress and uncertainty for students across the country.",
  },
  weatherResearch: {
    title: "Can AI predict the weather faster?",
    summary: "Researchers test a promising product for forecasting storms.",
  },
};

test("routine stories remain near the bottom of the scale", () => {
  assert.ok(calculateDoomIndexV12(stories.award).value <= 10);
  assert.ok(calculateDoomIndexV12(stories.funding).value <= 15);
  assert.ok(calculateDoomIndexV12(stories.weatherResearch).value <= 15);
});

test("product lifecycle language is not treated as literal violence", () => {
  const product = calculateDoomIndexV12(stories.productRetirement);
  const breach = calculateDoomIndexV12(stories.confirmedBreach);

  assert.ok(product.value <= 15);
  assert.ok(breach.value - product.value >= 40);
});

test("realized consequences outrank routine editorial importance", () => {
  const students = calculateDoomIndexV12(stories.studentFailure);
  const funding = calculateDoomIndexV12(stories.funding);

  assert.ok(students.value >= 40);
  assert.ok(students.value - funding.value >= 25);
});

test("a score can be reconstructed exactly from its stored factors", () => {
  const calculated = calculateDoomIndexV12(stories.confirmedBreach);
  const reconstructed = calculateDoomIndexV12FromFactors(calculated.factors);

  assert.equal(reconstructed.value, calculated.value);
});
