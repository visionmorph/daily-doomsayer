import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateDoomIndexV123,
  calculateDoomIndexV123FromFactors,
  createDoomIndexV123InputFingerprint,
} from "../scripts/doom-index-v1.2.3.mjs";

test("an unresolved commercial lawsuit is not mistaken for realized harm", () => {
  const result = calculateDoomIndexV123({
    title: "AI startup faces a trade secrets lawsuit",
    summary: "The unresolved court filing alleges that a competitor copied code.",
  });

  assert.equal(result.actuality, "disputed");
  assert.ok(result.value < 20);
});

test("confirmed institutional harm receives systemic context", () => {
  const result = calculateDoomIndexV123({
    title: "AI system wrongly denied public benefits",
    summary:
      "An investigation found that vulnerable people were wrongly denied benefits across the country.",
  });

  assert.ok(result.factors.systemicReach >= 0.5);
  assert.ok(result.factors.realizedHarm >= 0.6667);
  assert.ok(result.value >= 40);
});

test("a confirmed external production compromise can enter Dire", () => {
  const result = calculateDoomIndexV123({
    title: "AI agent gained unauthorized access to three companies",
    summary:
      "Investigators confirmed it compromised production systems using exposed credentials.",
  });

  assert.equal(result.actuality, "confirmed");
  assert.ok(result.value >= 60 && result.value < 80);
});

test("Catastrophic remains gated behind compound confirmed consequences", () => {
  const warning = calculateDoomIndexV123({
    title: "Researchers warn AI could cause widespread privacy harm",
    summary: "The proposed risk could affect millions of people someday.",
  });
  const catastrophe = calculateDoomIndexV123({
    title: "Millions of children targeted by nonconsensual AI imagery",
    summary:
      "An investigation confirmed the images were widely shared, causing irreversible harm across schools nationwide.",
  });

  assert.ok(warning.value < 60);
  assert.ok(catastrophe.value >= 80);
});

test("a 1.2.3 score reconstructs exactly from stored factors", () => {
  const calculated = calculateDoomIndexV123({
    title: "AI agent compromised production infrastructure",
    summary: "Researchers confirmed unauthorized access to multiple companies.",
  });
  const reconstructed = calculateDoomIndexV123FromFactors(calculated.factors);

  assert.equal(reconstructed.value, calculated.value);
});

test("the 1.2.3 input fingerprint changes with the scoring input", () => {
  const original = createDoomIndexV123InputFingerprint({
    title: "Example story",
    summary: "One company was affected.",
    coverageSources: 1,
  });
  const updated = createDoomIndexV123InputFingerprint({
    title: "Example story",
    summary: "Three companies were affected.",
    coverageSources: 2,
  });

  assert.notEqual(original, updated);
});
