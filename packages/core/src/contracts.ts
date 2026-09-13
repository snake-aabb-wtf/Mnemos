import { z } from "zod";

export const messageRoleSchema = z.enum(["system", "user", "assistant", "tool"]);
export type MessageRole = z.infer<typeof messageRoleSchema>;

export const historyMessageSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().min(1),
  role: messageRoleSchema,
  content: z.string(),
  createdAt: z.string().datetime(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type HistoryMessage = z.infer<typeof historyMessageSchema>;

export type NewHistoryMessage = Omit<HistoryMessage, "id" | "createdAt"> & {
  id?: string;
  createdAt?: string;
};

export interface HistoryStore {
  append(message: NewHistoryMessage): Promise<HistoryMessage>;
  get(sessionId: string, messageId: string): Promise<HistoryMessage | undefined>;
  list(sessionId: string, options?: { limit?: number }): Promise<HistoryMessage[]>;
}

export interface StateStore {
  get<T extends Record<string, unknown>>(sessionId: string): Promise<T | undefined>;
  set<T extends Record<string, unknown>>(sessionId: string, state: T): Promise<T>;
  patch<T extends Record<string, unknown>>(sessionId: string, patch: Partial<T>): Promise<T>;
}
