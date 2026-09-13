import type { MemoryRetrievalQuery, MemoryRetrievalResult } from "./retrieval.js";

export interface RetrievalEvaluationCase {
  id: string;
  query: string;
  options?: Omit<MemoryRetrievalQuery, "query">;
  /** Stable fixture labels, resolved to generated Memory IDs by the dataset runner. */
  expectedKeys: readonly string[];
}

/** Fixed Phase 5 regression fixture. It deliberately includes lexical, semantic, history, entity, and confidence cases. */
export const phase5RetrievalEvaluationCases: readonly RetrievalEvaluationCase[] = [
  { id: "exact-lexical", query: "PostgreSQL", expectedKeys: ["postgres-current"] },
  { id: "semantic-paraphrase", query: "项目的数据持久化最终选了什么？", expectedKeys: ["postgres-current"] },
  { id: "lexical-symbol", query: "CFG-9A", expectedKeys: ["config-symbol"] },
  { id: "entity", query: "database", expectedKeys: ["postgres-current"] },
  { id: "current-fact", query: "现在数据库方案是什么？", expectedKeys: ["postgres-current"] },
  { id: "historical-fact", query: "之前最开始用什么数据库？", options: { statuses: ["superseded"] }, expectedKeys: ["sqlite-history"] },
  { id: "confidence", query: "持久化方案", expectedKeys: ["postgres-current"] },
];

export interface RetrievalEvaluationResult {
  recallAtK: number;
  hitAtK: number;
  meanReciprocalRank: number;
  cases: readonly {
    id: string;
    hit: boolean;
    reciprocalRank: number;
  }[];
}

/** Deterministic metrics for detecting retrieval regressions without a large benchmark service. */
export function evaluateRetrieval(
  cases: readonly RetrievalEvaluationCase[],
  resultsByCase: ReadonlyMap<string, readonly MemoryRetrievalResult[]>,
  keyForMemory: (memoryId: string) => string | undefined,
  k: number,
): RetrievalEvaluationResult {
  if (!Number.isInteger(k) || k < 1) throw new Error("Evaluation K must be a positive integer");
  const details = cases.map((entry) => {
    const expected = new Set(entry.expectedKeys);
    const result = resultsByCase.get(entry.id) ?? [];
    const firstRank = result.findIndex((candidate) => {
      const key = keyForMemory(candidate.memory.id);
      return key !== undefined && expected.has(key);
    });
    return {
      id: entry.id,
      hit: firstRank !== -1 && firstRank < k,
      reciprocalRank: firstRank === -1 ? 0 : 1 / (firstRank + 1),
    };
  });
  return {
    recallAtK: details.length === 0 ? 0 : details.filter((detail) => detail.hit).length / details.length,
    hitAtK: details.length === 0 ? 0 : details.filter((detail) => detail.hit).length / details.length,
    meanReciprocalRank: details.length === 0 ? 0 : details.reduce((sum, detail) => sum + detail.reciprocalRank, 0) / details.length,
    cases: details,
  };
}
