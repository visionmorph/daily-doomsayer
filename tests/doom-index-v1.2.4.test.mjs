import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateDoomIndexV124,
  calculateDoomIndexV124FromFactors,
  createDoomIndexV124InputFingerprint,
} from "../scripts/doom-index-v1.2.4.mjs";

test("proposed legislation cannot become Dire from hypothetical harms", () => {
  const result = calculateDoomIndexV124({
    title: "The Senate should reject the AI monitoring bill",
    summary:
      "The proposed bill would require age verification and could create privacy risks, but still needs approval.",
  });

  assert.equal(result.actuality, "proposed");
  assert.ok(result.value >= 20 && result.value < 60);
});

test("observed autonomous malicious behavior can enter Dire", () => {
  const result = calculateDoomIndexV124({
    title: "AI agents used fake identities and malware in a rogue attack",
    summary:
      "Researchers documented unprompted actions that tried to deceive people and sabotage an external project.",
  });

  assert.ok(result.value >= 60 && result.value < 80);
  assert.ok(result.factors.lossOfControl >= 0.85);
});

test("demonstrated human-assisted hacking is material but not catastrophic", () => {
  const result = calculateDoomIndexV124({
    title: "Dangerous AI hacking techniques still have humans in the loop",
    summary:
      "A security researcher demonstrated how AI hacking abilities become more effective when combined with human expertise.",
  });

  assert.ok(result.value >= 40 && result.value < 80);
});

test("large institutional surveillance deployments reach Alarming", () => {
  const result = calculateDoomIndexV124({
    title: "Hundreds of drone-as-first-responder programs could launch",
    summary:
      "Police departments across the country are preparing automated surveillance drones and license plate collection.",
  });

  assert.ok(result.value >= 40 && result.value < 80);
});

test("sensitive medical recording receives meaningful privacy weight", () => {
  const result = calculateDoomIndexV124({
    title: "Medical provider records mental health care visits with AI",
    summary:
      "Patients and practitioners raised privacy concerns about recording confidential conversations.",
  });

  assert.ok(result.value >= 20 && result.value < 60);
});

test("routine product news remains Uneasy", () => {
  const result = calculateDoomIndexV124({
    title: "Cloud company launches a new AI assistant",
    summary: "The product update adds new workplace features.",
  });

  assert.ok(result.value < 20);
});

test("a 1.2.4 score reconstructs exactly from stored factors", () => {
  const calculated = calculateDoomIndexV124({
    title: "AI agent hacked another company",
    summary: "The company disclosed an AI agent breach of an external system.",
  });
  const reconstructed = calculateDoomIndexV124FromFactors(calculated.factors);

  assert.equal(reconstructed.value, calculated.value);
});

test("the 1.2.4 input fingerprint changes with its scoring input", () => {
  const original = createDoomIndexV124InputFingerprint({
    title: "Example story",
    summary: "One company was affected.",
    coverageSources: 1,
  });
  const updated = createDoomIndexV124InputFingerprint({
    title: "Example story",
    summary: "Three companies were affected.",
    coverageSources: 2,
  });

  assert.notEqual(original, updated);
});
