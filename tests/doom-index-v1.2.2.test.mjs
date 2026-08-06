import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateDoomIndexV122,
  calculateDoomIndexV122FromFactors,
  createDoomIndexV122InputFingerprint,
} from "../scripts/doom-index-v1.2.2.mjs";

test("non-human scientific language is not treated as human harm", () => {
  const result = calculateDoomIndexV122({
    title: "A star's violent death exposed a hidden supermassive black hole",
    summary:
      "Astronomers observed the stellar event in a distant galaxy with a telescope.",
  });

  assert.equal(result.actuality, "neutral");
  assert.equal(result.factors.realizedHarm, 0);
  assert.ok(result.value <= 8);
});

test("a controlled test is distinguished from an external incident", () => {
  const controlled = calculateDoomIndexV122({
    title: "AI models have been going rogue in tests",
    summary:
      "Researchers observed deception inside a controlled safety evaluation.",
  });
  const external = calculateDoomIndexV122({
    title: "AI model hacked into another company during testing",
    summary:
      "The model gained unauthorized access to production infrastructure.",
  });

  assert.equal(controlled.actuality, "testing");
  assert.equal(external.actuality, "confirmed");
  assert.ok(external.value - controlled.value >= 15);
});

test("equivalent descriptions of the same intrusion receive similar scores", () => {
  const malwareHeadline = calculateDoomIndexV122({
    title:
      "Anthropic's AI used fake identities and malware in a rogue attack on a project",
    summary: "Researchers confirmed the incident.",
  });
  const plainHeadline = calculateDoomIndexV122({
    title:
      "Anthropic AI used fake profiles to target people in a hack then hid the evidence",
    summary: "Researchers confirmed the incident.",
  });

  assert.equal(malwareHeadline.actuality, "confirmed");
  assert.equal(plainHeadline.actuality, "confirmed");
  assert.equal(malwareHeadline.polarity, "adverse");
  assert.equal(plainHeadline.polarity, "adverse");
  assert.ok(malwareHeadline.value >= 35);
  assert.ok(plainHeadline.value >= 35);
  assert.ok(Math.abs(malwareHeadline.value - plainHeadline.value) <= 5);
});

test("confirmed consequences outrank proposed concern", () => {
  const proposed = calculateDoomIndexV122({
    title: "The Senate Should Reject the AI Privacy Act's Risks",
    summary:
      "The proposed bill could harm children and restrict freedom of speech.",
  });
  const confirmed = calculateDoomIndexV122({
    title:
      "An AI-supervised exam failed and 58,000 students must retake it",
    summary:
      "The confirmed malfunction forced students across the country to repeat it.",
  });

  assert.equal(proposed.actuality, "proposed");
  assert.equal(confirmed.actuality, "confirmed");
  assert.ok(confirmed.value >= 40);
  assert.ok(confirmed.value - proposed.value >= 15);
});

test("a 1.2.2 score reconstructs exactly from stored factors", () => {
  const calculated = calculateDoomIndexV122({
    title: "AI agent attacked three companies",
    summary:
      "Investigators confirmed unauthorized access to production systems.",
  });
  const reconstructed = calculateDoomIndexV122FromFactors(calculated.factors);

  assert.equal(reconstructed.value, calculated.value);
});

test("the input fingerprint changes when auditable scoring input changes", () => {
  const original = createDoomIndexV122InputFingerprint({
    title: "Example story",
    summary: "One company was affected.",
    coverageSources: 1,
  });
  const updated = createDoomIndexV122InputFingerprint({
    title: "Example story",
    summary: "Three companies were affected.",
    coverageSources: 2,
  });

  assert.notEqual(original, updated);
});
