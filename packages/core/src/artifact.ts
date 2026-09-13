import { z } from "zod";

/** Opaque reference that is safe to expose in a model context. */
export const artifactIdSchema = z.string().regex(
  /^artifact:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  "Artifact ids must use the artifact://<uuid> form",
);
export type ArtifactId = z.infer<typeof artifactIdSchema>;

export const artifactScopeSchema = z.enum(["session", "persistent"]);
export type ArtifactScope = z.infer<typeof artifactScopeSchema>;

export const artifactRecordSchema = z.object({
  id: artifactIdSchema,
  /** Required for session artifacts; absent for durable shared artifacts. */
  sessionId: z.string().min(1).optional(),
  scope: artifactScopeSchema,
  type: z.string().min(1).max(128),
  mimeType: z.string().min(1).max(255).optional(),
  sizeBytes: z.number().int().nonnegative(),
  /** Internal opaque location. It must never be rendered as visible context. */
  storageLocation: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  summary: z.string().max(16_384).optional(),
  displayName: z.string().min(1).max(512).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
}).superRefine((record, context) => {
  if (record.scope === "session" && record.sessionId === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Session artifacts require a sessionId", path: ["sessionId"] });
  }
});
export type ArtifactRecord = z.infer<typeof artifactRecordSchema>;

/** The only Artifact representation intended for a visible-agent context. */
export const artifactHandleSchema = z.object({
  id: artifactIdSchema,
  type: z.string().min(1).max(128),
  mimeType: z.string().min(1).max(255).optional(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  summary: z.string().max(16_384).optional(),
});
export type ArtifactHandle = z.infer<typeof artifactHandleSchema>;

export function toArtifactHandle(record: ArtifactRecord): ArtifactHandle {
  return artifactHandleSchema.parse({
    id: record.id,
    type: record.type,
    ...(record.mimeType === undefined ? {} : { mimeType: record.mimeType }),
    sizeBytes: record.sizeBytes,
    sha256: record.sha256,
    ...(record.summary === undefined ? {} : { summary: record.summary }),
  });
}

export type ArtifactContent = string | Uint8Array | AsyncIterable<Uint8Array>;

export const artifactCreateOptionsSchema = z.object({
  sessionId: z.string().min(1).optional(),
  scope: artifactScopeSchema.default("session"),
  type: z.string().min(1).max(128),
  mimeType: z.string().min(1).max(255).optional(),
  summary: z.string().max(16_384).optional(),
  displayName: z.string().min(1).max(512).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  expiresAt: z.string().datetime().optional(),
}).superRefine((input, context) => {
  if (input.scope === "session" && input.sessionId === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Session artifacts require a sessionId", path: ["sessionId"] });
  }
});
/** Input type intentionally keeps Zod defaults optional for callers. */
export type ArtifactCreateOptions = z.input<typeof artifactCreateOptionsSchema>;
export type ArtifactCreateInput = ArtifactCreateOptions & { content: ArtifactContent };

export const artifactReadOptionsSchema = z.object({
  offset: z.number().int().nonnegative().default(0),
  length: z.number().int().positive().optional(),
});
export type ArtifactReadOptions = z.input<typeof artifactReadOptionsSchema>;

export const artifactQueryOptionsSchema = z.object({
  // The storage index overlaps 4 KiB between chunks, so this remains queryable
  // even when a term lands on a chunk boundary.
  query: z.string().trim().min(1).max(1_024),
  maxMatches: z.number().int().positive().max(100).default(20),
  maxSnippetBytes: z.number().int().positive().max(16_384).default(1_024),
  maxReturnedBytes: z.number().int().positive().max(131_072).default(16_384),
});
export type ArtifactQueryOptions = z.input<typeof artifactQueryOptionsSchema>;

export const artifactQueryMatchSchema = z.object({
  artifactId: artifactIdSchema,
  byteOffset: z.number().int().nonnegative(),
  lineNumber: z.number().int().positive(),
  snippet: z.string(),
});
export type ArtifactQueryMatch = z.infer<typeof artifactQueryMatchSchema>;

export interface ArtifactRecoveryReport {
  readonly deletedOrphanLocations: readonly string[];
  readonly missingBodyIds: readonly ArtifactId[];
}

export interface ArtifactStore {
  create(input: ArtifactCreateInput): Promise<ArtifactRecord>;
  get(id: ArtifactId | string): Promise<ArtifactRecord | undefined>;
  read(id: ArtifactId | string, options?: ArtifactReadOptions): Promise<Uint8Array>;
  delete(id: ArtifactId | string): Promise<boolean>;
  query(id: ArtifactId | string, options: ArtifactQueryOptions): Promise<readonly ArtifactQueryMatch[]>;
  rebuildTextIndex(id: ArtifactId | string): Promise<number>;
  /** Verifies that the backing body still matches the metadata checksum. */
  verify(id: ArtifactId | string): Promise<boolean>;
  cleanupExpired(now?: Date): Promise<readonly ArtifactId[]>;
  recoverOrphans(): Promise<ArtifactRecoveryReport>;
}

export class ArtifactNotFoundError extends Error {
  constructor(id: string) {
    super(`Artifact not found: ${id}`);
    this.name = "ArtifactNotFoundError";
  }
}

export class ArtifactBodyMissingError extends Error {
  constructor(id: string) {
    super(`Artifact body is missing: ${id}`);
    this.name = "ArtifactBodyMissingError";
  }
}

export class ArtifactIntegrityError extends Error {
  constructor(id: string) {
    super(`Artifact checksum does not match: ${id}`);
    this.name = "ArtifactIntegrityError";
  }
}

export class ArtifactQueryUnsupportedError extends Error {
  constructor(id: string) {
    super(`Artifact is not queryable text: ${id}`);
    this.name = "ArtifactQueryUnsupportedError";
  }
}

export const defaultArtifactSpillPolicy = {
  /** Text at or below this remains eligible for direct caller handling. */
  maxInlineBytes: 64 * 1024,
  /** Larger text must be kept out of model context as an Artifact. */
  spillThresholdBytes: 256 * 1024,
} as const;

export interface ArtifactSpillPolicy {
  maxInlineBytes: number;
  spillThresholdBytes: number;
}

export const artifactSpillPolicySchema = z.object({
  maxInlineBytes: z.number().int().nonnegative(),
  spillThresholdBytes: z.number().int().positive(),
});

export type ArtifactSpillInput = Omit<ArtifactCreateInput, "content"> & { content: ArtifactContent };
export interface ArtifactSpillOptions {
  /** Runtime result processing can force externalization even below its local policy. */
  forceArtifact?: boolean;
}
export type ArtifactSpillResult =
  | { kind: "inline"; content: string; sizeBytes: number }
  | { kind: "artifact"; handle: ArtifactHandle };

/**
 * Small, deterministic spill boundary used by future tool dispatchers. This is
 * deliberately not a dispatcher: Phase 6 must not introduce tool execution.
 */
export class ArtifactSpillService {
  readonly policy: ArtifactSpillPolicy;

  constructor(private readonly store: ArtifactStore, policy: Partial<ArtifactSpillPolicy> = {}) {
    this.policy = artifactSpillPolicySchema.parse({ ...defaultArtifactSpillPolicy, ...policy });
  }

  async spill(input: ArtifactSpillInput, options: ArtifactSpillOptions = {}): Promise<ArtifactSpillResult> {
    if (typeof input.content === "string") {
      const sizeBytes = Buffer.byteLength(input.content);
      // Both controls matter: the threshold expresses normal spill behavior and
      // maxInlineBytes remains a hard context-safety cap for callers.
      const inlineLimit = Math.min(this.policy.maxInlineBytes, this.policy.spillThresholdBytes);
      if (!options.forceArtifact && sizeBytes <= inlineLimit) return { kind: "inline", content: input.content, sizeBytes };
    }
    const record = await this.store.create(input);
    return { kind: "artifact", handle: toArtifactHandle(record) };
  }
}
