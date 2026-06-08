import { describe, expect, test } from "bun:test";
import { scoreRetrievalCandidate } from "./memory";

describe("scoreRetrievalCandidate", () => {
  test("confidence multiplies the score — a demoted fact ranks below an equal one", () => {
    const high = scoreRetrievalCandidate({
      combinedScore: 0.6,
      freshness: 1,
      confidence: 1,
      projectBonus: 0,
    });
    const demoted = scoreRetrievalCandidate({
      combinedScore: 0.6,
      freshness: 1,
      confidence: 0.3,
      projectBonus: 0,
    });
    expect(demoted).toBeLessThan(high);
    expect(demoted).toBeCloseTo(high * 0.3, 10);
  });

  test("the project bonus is additive and not scaled by confidence", () => {
    const noBonus = scoreRetrievalCandidate({
      combinedScore: 0.5,
      freshness: 1,
      confidence: 0.5,
      projectBonus: 0,
    });
    const withBonus = scoreRetrievalCandidate({
      combinedScore: 0.5,
      freshness: 1,
      confidence: 0.5,
      projectBonus: 0.02,
    });
    expect(withBonus - noBonus).toBeCloseTo(0.02, 10);
  });

  test("falls back to 0.5 base when combinedScore is zero", () => {
    const score = scoreRetrievalCandidate({
      combinedScore: 0,
      freshness: 1,
      confidence: 1,
      projectBonus: 0,
    });
    expect(score).toBeCloseTo(0.5, 10);
  });

  test("freshness and confidence compound", () => {
    const score = scoreRetrievalCandidate({
      combinedScore: 1,
      freshness: 0.5,
      confidence: 0.5,
      projectBonus: 0,
    });
    expect(score).toBeCloseTo(0.25, 10);
  });
});
