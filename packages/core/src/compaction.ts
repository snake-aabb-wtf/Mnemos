import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pinnedContextSchema, type BuiltContext, type ContextManager, type PinnedContext, type TokenEstimator } from "./context.js";
import type { HistoryMessage, HistoryStore } from "./contracts.js";

export type ContextBoundaryKind = "task" | "turn" | "tool-transaction" | "message";

export interface BoundarySelection {
  kind: ContextBoundaryKind;
  targetRetainedTokens: number;
  actualRetainedTokens: number;
  searchWindowTokens: number;
  cutoffAfterMessageId: string;
  cutoffBeforeMessageId: string;
  evictedMessages: readonly HistoryMessage[];
  retainedMessages: readonly HistoryMessage[];
}

interface MessageGroup {
  messages: readonly HistoryMessage[];
  tokens: number;
  boundaryAfter: ContextBoundaryKind;
}

interface BoundaryCandidate {
  groupIndex: number;
  evictedTokens: number;
  retainedTokens: number;
  kind: ContextBoundaryKind;
}

const boundaryPriority: Record<ContextBoundaryKind, number> = {
  task: 4,
  turn: 3,
  "tool-transaction": 2,
  message: 1,
};

/**
 * Selects an eviction cutoff only between complete logical groups. It never
 * slices a message, a user-led turn, or a contiguous tool transaction.
 */
export class BoundarySelector {
  constructor(private readonly estimator: TokenEstimator, private readonly searchWindowTokens: number) {}

  select(messages: readonly HistoryMessage[], targetRetainedTokens: number): BoundarySelection | undefined {
    const groups = this.toGroups(messages);
    if (groups.length < 2) return undefined;

    const totalTokens = groups.reduce((sum, group) => sum + group.tokens, 0);
    const targetEvictedTokens = Math.max(0, totalTokens - targetRetainedTokens);
    const candidates: BoundaryCandidate[] = [];
    let evictedTokens = 0;
    for (let index = 0; index < groups.length - 1; index += 1) {
      evictedTokens += groups[index].tokens;
      candidates.push({
        groupIndex: index,
        evictedTokens,
        retainedTokens: totalTokens - evictedTokens,
        kind: groups[index].boundaryAfter,
      });
    }

    const withinSearchWindow = (candidate: BoundaryCandidate) =>
      Math.abs(candidate.evictedTokens - targetEvictedTokens) <= this.searchWindowTokens;
    const leavesTargetSizedRaw = (candidate: BoundaryCandidate) => candidate.retainedTokens <= targetRetainedTokens;
    const targetSized = candidates.filter(leavesTargetSizedRaw);
    const targetSizedWithinWindow = targetSized.filter(withinSearchWindow);
    const candidatesWithinWindow = candidates.filter(withinSearchWindow);
    const preferBoundaryKind = targetSizedWithinWindow.length > 0 || (targetSized.length === 0 && candidatesWithinWindow.length > 0);
    const pool = targetSizedWithinWindow.length > 0
      ? targetSizedWithinWindow
      : targetSized.length > 0
        ? targetSized
        : candidatesWithinWindow.length > 0
          ? candidatesWithinWindow
          : candidates;
    const selected = [...pool].sort((left, right) => {
      const priority = boundaryPriority[right.kind] - boundaryPriority[left.kind];
      const distance = Math.abs(left.evictedTokens - targetEvictedTokens) - Math.abs(right.evictedTokens - targetEvictedTokens);
      if (preferBoundaryKind && priority !== 0) return priority;
      if (distance !== 0) return distance;
      if (priority !== 0) return priority;
      return right.evictedTokens - left.evictedTokens;
    })[0];

    const evictedMessages = groups.slice(0, selected.groupIndex + 1).flatMap((group) => group.messages);
    const retainedMessages = groups.slice(selected.groupIndex + 1).flatMap((group) => group.messages);
    return {
      kind: selected.kind,
      targetRetainedTokens,
      actualRetainedTokens: selected.retainedTokens,
      searchWindowTokens: this.searchWindowTokens,
      cutoffAfterMessageId: evictedMessages.at(-1)!.id,
      cutoffBeforeMessageId: retainedMessages[0].id,
      evictedMessages,
      retainedMessages,
    };
  }

  private toGroups(messages: readonly HistoryMessage[]): MessageGroup[] {
    if (messages.length === 0) return [];
    const groups: MessageGroup[] = [];
    let current: HistoryMessage[] = [messages[0]];
    for (let index = 1; index < messages.length; index += 1) {
      const previous = messages[index - 1];
      const next = messages[index];
      if (this.startsNewGroup(current, previous, next)) {
        groups.push({
          messages: current,
          tokens: this.tokens(current),
          boundaryAfter: this.boundaryKind(previous, next),
        });
        current = [next];
      } else {
        current.push(next);
      }
    }
    groups.push({ messages: current, tokens: this.tokens(current), boundaryAfter: "message" });
    return groups;
  }

  private startsNewGroup(current: readonly HistoryMessage[], previous: HistoryMessage, next: HistoryMessage): boolean {
    const previousTransaction = this.metadataString(previous, "transactionId");
    const nextTransaction = this.metadataString(next, "transactionId");
    if (previousTransaction !== undefined || nextTransaction !== undefined) return previousTransaction !== nextTransaction;
    if (next.role === "user") return true;
    // A user-led turn keeps every following assistant and tool message together.
    if (current[0].role === "user") return false;
    return true;
  }

  private boundaryKind(previous: HistoryMessage, next: HistoryMessage): ContextBoundaryKind {
    const previousTask = this.metadataString(previous, "taskId");
    const nextTask = this.metadataString(next, "taskId");
    if (previousTask !== undefined && nextTask !== undefined && previousTask !== nextTask) return "task";
    if (next.role === "user") return "turn";
    const previousTransaction = this.metadataString(previous, "transactionId");
    const nextTransaction = this.metadataString(next, "transactionId");
    if (previousTransaction !== nextTransaction) return "tool-transaction";
    return "message";
  }

  private tokens(messages: readonly HistoryMessage[]): number {
    return messages.reduce((sum, message) => sum + this.estimator.estimateMessage(message), 0);
  }

  private metadataString(message: HistoryMessage, key: string): string | undefined {
    const value = message.metadata?.[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }
}

export const contextCompactionCheckpointSchema = z.object({
  sessionId: z.string().min(1),
  evictedThroughMessageId: z.string().uuid().optional(),
  automaticPin: pinnedContextSchema.optional(),
  updatedAt: z.string().datetime(),
});
export type ContextCompactionCheckpoint = z.infer<typeof contextCompactionCheckpointSchema>;

export interface ContextCompactionStore {
  get(sessionId: string): Promise<ContextCompactionCheckpoint | undefined>;
  set(checkpoint: ContextCompactionCheckpoint): Promise<void>;
}

/** Useful for embedders and tests that do not require process-restart durability. */
export class InMemoryContextCompactionStore implements ContextCompactionStore {
  private readonly checkpoints = new Map<string, ContextCompactionCheckpoint>();

  async get(sessionId: string): Promise<ContextCompactionCheckpoint | undefined> {
    return this.clone(this.checkpoints.get(sessionId));
  }

  async set(checkpoint: ContextCompactionCheckpoint): Promise<void> {
    this.checkpoints.set(checkpoint.sessionId, this.clone(checkpoint)!);
  }

  private clone(checkpoint: ContextCompactionCheckpoint | undefined): ContextCompactionCheckpoint | undefined {
    return checkpoint === undefined ? undefined : structuredClone(checkpoint);
  }
}

export interface CompactionSummaryRequest {
  sessionId: string;
  previousPin?: PinnedContext;
  sourceRange: NonNullable<PinnedContext["sourceRange"]>;
  evictedMessages: readonly HistoryMessage[];
  tokenBudget: number;
  estimator: TokenEstimator;
}

export interface CompactionSummarizer {
  summarize(request: CompactionSummaryRequest): Promise<string>;
}

/**
 * A bounded, deterministic fallback. Production summarizers may use a model,
 * but lifecycle correctness must not depend on summary quality.
 */
export class DeterministicCompactionSummarizer implements CompactionSummarizer {
  async summarize(request: CompactionSummaryRequest): Promise<string> {
    if (request.tokenBudget === 0) return "";
    const excerpts = request.evictedMessages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .slice(-2)
      .map((message) => `- ${message.role}: ${this.singleLine(message.content, 320)}`);
    const prior = request.previousPin?.content
      ? `Prior compaction retained: ${this.singleLine(request.previousPin.content, 240)}`
      : undefined;
    const source = `Canonical source: ${request.sourceRange.firstMessageId} through ${request.sourceRange.lastMessageId} (${request.sourceRange.messageCount} messages).`;
    return this.fit(["# Compacted Context", prior, source, "## Latest evicted work", ...excerpts].filter(Boolean).join("\n"), request);
  }

  private singleLine(value: string, limit: number): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 1))}…`;
  }

  private fit(content: string, request: CompactionSummaryRequest): string {
    if (request.estimator.estimateText(content) <= request.tokenBudget) return content;
    let low = 0;
    let high = content.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const candidate = `${content.slice(0, middle)}…`;
      if (request.estimator.estimateText(candidate) <= request.tokenBudget) low = middle;
      else high = middle - 1;
    }
    return low === 0 ? "" : `${content.slice(0, low)}…`;
  }
}

export interface ContextEviction {
  compactionId: string;
  sessionId: string;
  evictedMessages: readonly HistoryMessage[];
  evictedMessageIds: readonly string[];
  sourceRange: NonNullable<PinnedContext["sourceRange"]>;
  retainedFromMessageId: string;
  cutoff: Omit<BoundarySelection, "evictedMessages" | "retainedMessages">;
  pinnedContext: PinnedContext;
}

export interface CompactionPreparation {
  context: BuiltContext;
  evictions: readonly ContextEviction[];
}

export interface CompactionServiceOptions {
  history: HistoryStore;
  checkpoints: ContextCompactionStore;
  context: ContextManager;
  summarizer?: CompactionSummarizer;
  cutoffSearchWindowTokens?: number;
  automaticPinTokenBudget?: number;
}

/**
 * Converts canonical history into a bounded visible working context. It only
 * advances a checkpoint; HistoryStore is never mutated by this service.
 */
export class CompactionService {
  private readonly selector: BoundarySelector;
  private readonly summarizer: CompactionSummarizer;
  private readonly automaticPinTokenBudget: number;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly options: CompactionServiceOptions) {
    this.selector = new BoundarySelector(
      options.context.getTokenEstimator(),
      options.cutoffSearchWindowTokens ?? Math.floor(options.context.budgets.recentRawTokenBudget / 6),
    );
    this.summarizer = options.summarizer ?? new DeterministicCompactionSummarizer();
    this.automaticPinTokenBudget = options.automaticPinTokenBudget ?? Math.floor(options.context.budgets.pinnedTokenBudget / 2);
  }

  prepare(sessionId: string, systemPrompt = "", toolSchemas: readonly string[] = []): Promise<CompactionPreparation> {
    return this.withSessionLock(sessionId, () => this.prepareUnlocked(sessionId, systemPrompt, toolSchemas));
  }

  private async prepareUnlocked(sessionId: string, systemPrompt: string, toolSchemas: readonly string[]): Promise<CompactionPreparation> {
    let checkpoint = await this.options.checkpoints.get(sessionId);
    if (checkpoint?.automaticPin) this.options.context.upsertPin(checkpoint.automaticPin);

    const history = await this.options.history.list(sessionId);
    let recentMessages = this.afterCheckpoint(history, checkpoint?.evictedThroughMessageId);
    const evictions: ContextEviction[] = [];

    while (this.needsCompaction(sessionId, recentMessages, systemPrompt, toolSchemas)) {
      const selection = this.selector.select(recentMessages, this.options.context.budgets.recentRawTokenBudget);
      if (!selection) break;

      const sourceRange = this.nextSourceRange(checkpoint?.automaticPin, selection.evictedMessages);
      const tokenBudget = Math.min(
        this.automaticPinTokenBudget,
        this.options.context.availablePinTokens(sessionId, "automatic-compaction"),
      );
      const content = await this.summarizer.summarize({
        sessionId,
        previousPin: checkpoint?.automaticPin,
        sourceRange,
        evictedMessages: selection.evictedMessages,
        tokenBudget,
        estimator: this.options.context.getTokenEstimator(),
      });
      const automaticPin: PinnedContext = {
        id: "automatic-compaction",
        sessionId,
        source: "automatic",
        content,
        sourceRange,
      };
      const previousPin = this.options.context.upsertPin(automaticPin);
      const nextCheckpoint: ContextCompactionCheckpoint = {
        sessionId,
        evictedThroughMessageId: selection.cutoffAfterMessageId,
        automaticPin,
        updatedAt: new Date().toISOString(),
      };
      try {
        await this.options.checkpoints.set(nextCheckpoint);
      } catch (error) {
        if (previousPin) this.options.context.upsertPin(previousPin);
        else this.options.context.removePin(automaticPin.id, sessionId);
        throw error;
      }
      checkpoint = nextCheckpoint;
      recentMessages = [...selection.retainedMessages];
      evictions.push({
        compactionId: randomUUID(),
        sessionId,
        evictedMessages: selection.evictedMessages,
        evictedMessageIds: selection.evictedMessages.map((message) => message.id),
        sourceRange,
        retainedFromMessageId: selection.cutoffBeforeMessageId,
        cutoff: {
          kind: selection.kind,
          targetRetainedTokens: selection.targetRetainedTokens,
          actualRetainedTokens: selection.actualRetainedTokens,
          searchWindowTokens: selection.searchWindowTokens,
          cutoffAfterMessageId: selection.cutoffAfterMessageId,
          cutoffBeforeMessageId: selection.cutoffBeforeMessageId,
        },
        pinnedContext: automaticPin,
      });
    }
    return { context: this.options.context.buildVisible(sessionId, recentMessages, systemPrompt, [], toolSchemas), evictions };
  }

  private needsCompaction(sessionId: string, recentMessages: readonly HistoryMessage[], systemPrompt: string, toolSchemas: readonly string[]): boolean {
    const context = this.options.context.buildVisible(sessionId, recentMessages, systemPrompt, [], toolSchemas);
    return context.stats.recentRawTokens > this.options.context.budgets.recentRawTokenBudget
      || context.stats.pressure >= this.options.context.budgets.highPressureThreshold;
  }

  private afterCheckpoint(history: readonly HistoryMessage[], evictedThroughMessageId?: string): HistoryMessage[] {
    if (evictedThroughMessageId === undefined) return [...history];
    const checkpointIndex = history.findIndex((message) => message.id === evictedThroughMessageId);
    if (checkpointIndex === -1) throw new Error("Compaction checkpoint is not present in canonical history");
    return history.slice(checkpointIndex + 1);
  }

  private nextSourceRange(previousPin: PinnedContext | undefined, evicted: readonly HistoryMessage[]): NonNullable<PinnedContext["sourceRange"]> {
    const first = previousPin?.sourceRange?.firstMessageId ?? evicted[0].id;
    const previousCount = previousPin?.sourceRange?.messageCount ?? 0;
    return {
      firstMessageId: first,
      lastMessageId: evicted.at(-1)!.id,
      messageCount: previousCount + evicted.length,
    };
  }

  private async withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(sessionId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = prior.then(() => gate);
    this.queues.set(sessionId, queued);
    await prior;
    try {
      return await operation();
    } finally {
      release();
      if (this.queues.get(sessionId) === queued) this.queues.delete(sessionId);
    }
  }
}
