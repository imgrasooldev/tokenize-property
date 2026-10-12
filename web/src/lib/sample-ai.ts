/**
 * SAMPLE content for the AI analyst concept shown in the design. Nothing here is computed: there is
 * no AI model in the prototype yet. Every place that shows these values labels them "Sample" and
 * says AI output is informational, never investment advice.
 */
export interface SampleScore {
  score: number;
  factors: { key: "tenant" | "lease" | "location" | "liquidity" | "title"; value: number }[];
}

export const SAMPLE_AI_SCORES: Record<string, SampleScore> = {
  GPF3: {
    score: 82,
    factors: [
      { key: "tenant", value: 92 },
      { key: "lease", value: 85 },
      { key: "location", value: 80 },
      { key: "liquidity", value: 61 },
      { key: "title", value: 90 },
    ],
  },
  DHA6: {
    score: 77,
    factors: [
      { key: "tenant", value: 80 },
      { key: "lease", value: 82 },
      { key: "location", value: 78 },
      { key: "liquidity", value: 55 },
      { key: "title", value: 88 },
    ],
  },
  BAO2: {
    score: 79,
    factors: [
      { key: "tenant", value: 84 },
      { key: "lease", value: 76 },
      { key: "location", value: 83 },
      { key: "liquidity", value: 58 },
      { key: "title", value: 89 },
    ],
  },
};

export function sampleScore(symbol: string): SampleScore | undefined {
  return new Map(Object.entries(SAMPLE_AI_SCORES)).get(symbol);
}
