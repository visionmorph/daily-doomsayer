import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateDoomIndexV121,
  calculateDoomIndexV121FromFactors,
} from "../scripts/doom-index-v1.2.1.mjs";

const stories = {
  leadership: {
    title: "Google announces a major shakeup of its top AI leadership",
    summary: "The company appointed new executives.",
  },
  award: {
    title: "Scientist receives a major artificial intelligence prize",
    summary: "The award recognizes contributions to robotics.",
  },
  funding: {
    title: "Listen Labs raises $69M to scale AI customer interviews",
    summary:
      "The startup announced a new funding round that could expand its product.",
  },
  proposedPolicy: {
    title: "The Senate Should Reject KOSA's Privacy Risks",
    summary:
      "The proposed bill could harm children and restrict freedom of speech online.",
  },
  confirmedBreach: {
    title:
      "AI agent attacked three companies after finding exposed credentials",
    summary:
      "Researchers confirmed it gained unauthorized access to production infrastructure and targeted user accounts.",
  },
  recalledProducts: {
    title:
      "AI TikTok Shop Slop Factory Shills Supplements Recalled By the FDA",
    summary:
      "The investigation found harmful products marketed to vulnerable people.",
  },
  studentFailure: {
    title:
      "An AI-supervised exam went so badly that 58,000 students must retake it",
    summary:
      "The confirmed malfunction forced students across the country to repeat the examination.",
  },
  nuclearEfficiency: {
    title: "Working to automate nuclear plant operations",
    summary:
      "Researchers successfully improved efficiency and reduced repetitive work.",
  },
  protectiveTool: {
    title: "NASA Data Powers New Tool to Protect Water Supply After Fires",
    summary:
      "The tool is designed to prepare communities and prevent water shortages.",
  },
  productRetirement: {
    title: "Google plans to kill Assistant on your phone",
    summary:
      "Users may need a forced upgrade because some devices are incompatible.",
  },
  favorableCourtOutcome: {
    title: "Appeals Court Agrees That Building a Browser Is Not a Crime",
    summary: "The ruling protects researchers and rejects the legal claim.",
  },
  rogueTest: {
    title: "AI models have been going rogue in tests - how worried should we be?",
    summary:
      "Researchers found models deceiving humans and using fake identities during testing.",
  },
};

test("routine and positive stories remain low", () => {
  assert.ok(calculateDoomIndexV121(stories.leadership).value <= 10);
  assert.ok(calculateDoomIndexV121(stories.award).value <= 10);
  assert.ok(calculateDoomIndexV121(stories.funding).value <= 12);
});

test("proposed harm cannot outrank a confirmed multi-company intrusion", () => {
  const proposed = calculateDoomIndexV121(stories.proposedPolicy);
  const confirmed = calculateDoomIndexV121(stories.confirmedBreach);

  assert.equal(proposed.actuality, "proposed");
  assert.equal(confirmed.actuality, "confirmed");
  assert.ok(proposed.value >= 15 && proposed.value <= 35);
  assert.ok(confirmed.value >= 55);
  assert.ok(confirmed.value - proposed.value >= 25);
});

test("recognized real-world consequences reach the upper half of the scale", () => {
  assert.ok(calculateDoomIndexV121(stories.recalledProducts).value >= 40);
  assert.ok(calculateDoomIndexV121(stories.studentFailure).value >= 40);
});

test("an observed rogue test is confirmed rather than merely speculative", () => {
  const result = calculateDoomIndexV121(stories.rogueTest);

  assert.equal(result.actuality, "confirmed");
  assert.ok(result.value >= 35);
});

test("protective and favorable contexts reduce ambient threat language", () => {
  assert.ok(calculateDoomIndexV121(stories.nuclearEfficiency).value <= 12);
  assert.ok(calculateDoomIndexV121(stories.protectiveTool).value <= 12);
  assert.ok(calculateDoomIndexV121(stories.favorableCourtOutcome).value <= 15);
});

test("product retirement receives mild context rather than literal violence", () => {
  const result = calculateDoomIndexV121(stories.productRetirement);

  assert.ok(result.value >= 10 && result.value <= 25);
  assert.equal(result.factors.realizedHarm, 0);
});

test("a 1.2.1 score reconstructs exactly from its stored factors", () => {
  const calculated = calculateDoomIndexV121(stories.confirmedBreach);
  const reconstructed = calculateDoomIndexV121FromFactors(calculated.factors);

  assert.equal(reconstructed.value, calculated.value);
});
