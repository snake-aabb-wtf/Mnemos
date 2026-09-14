import Database from "better-sqlite3";
import { agentTaskSchema, type AgentTask, type AgentTaskStatus, type AgentTaskStore } from "@mnemos/core";

interface StoredTask {
  id: string; parent_task_id: string | null; session_id: string; created_by: string; assigned_agent_id: string | null;
  objective: string; input: string; output_references: string; memory_references: string; artifact_references: string;
  dependency_ids: string; status: AgentTaskStatus; failure_policy: string; attempt: number; revision: number;
  lease_until: string | null; worker_id: string | null; created_at: string; updated_at: string; max_attempts: number; metadata: string;
}

function open(filename: string): Database.Database {
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.exec(`CREATE TABLE IF NOT EXISTS agent_tasks (
    id TEXT PRIMARY KEY, parent_task_id TEXT, session_id TEXT NOT NULL, created_by TEXT NOT NULL,
    assigned_agent_id TEXT, objective TEXT NOT NULL, input TEXT NOT NULL, output_references TEXT NOT NULL,
    memory_references TEXT NOT NULL, artifact_references TEXT NOT NULL, dependency_ids TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','running','waiting','completed','failed','cancelled','blocked')),
    failure_policy TEXT NOT NULL CHECK(failure_policy IN ('fail-fast','continue-with-partial')),
    attempt INTEGER NOT NULL, revision INTEGER NOT NULL, lease_until TEXT, worker_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, max_attempts INTEGER NOT NULL, metadata TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_agent_tasks_ready ON agent_tasks(status, created_at, id);
  CREATE INDEX IF NOT EXISTS idx_agent_tasks_parent ON agent_tasks(parent_task_id);`);
  return db;
}

export class SqliteAgentTaskStore implements AgentTaskStore {
  private readonly db: Database.Database;
  constructor(filename: string) { this.db = open(filename); }

  async create(task: AgentTask): Promise<AgentTask> {
    const parsed = agentTaskSchema.parse(task);
    this.db.prepare(`INSERT INTO agent_tasks (id,parent_task_id,session_id,created_by,assigned_agent_id,objective,input,output_references,memory_references,artifact_references,dependency_ids,status,failure_policy,attempt,revision,lease_until,worker_id,created_at,updated_at,max_attempts,metadata) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      parsed.id, parsed.parentTaskId ?? null, parsed.sessionId, parsed.createdBy, parsed.assignedAgentId ?? null, parsed.objective,
      JSON.stringify(parsed.input), JSON.stringify(parsed.outputReferences), JSON.stringify(parsed.memoryReferences), JSON.stringify(parsed.artifactReferences), JSON.stringify(parsed.dependencyIds), parsed.status, parsed.failurePolicy, parsed.attempt, parsed.revision, parsed.leaseUntil ?? null, parsed.workerId ?? null, parsed.createdAt, parsed.updatedAt, parsed.maxAttempts, JSON.stringify(parsed.metadata),
    );
    return parsed;
  }

  async get(id: string): Promise<AgentTask | undefined> { const row = this.db.prepare("SELECT * FROM agent_tasks WHERE id=?").get(id) as StoredTask | undefined; return row === undefined ? undefined : this.toTask(row); }

  async list(filter: { sessionId?: string; status?: AgentTaskStatus; parentTaskId?: string } = {}): Promise<readonly AgentTask[]> {
    const clauses: string[] = []; const values: string[] = [];
    if (filter.sessionId !== undefined) { clauses.push("session_id=?"); values.push(filter.sessionId); }
    if (filter.status !== undefined) { clauses.push("status=?"); values.push(filter.status); }
    if (filter.parentTaskId !== undefined) { clauses.push("parent_task_id=?"); values.push(filter.parentTaskId); }
    const sql = `SELECT * FROM agent_tasks${clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`} ORDER BY created_at,id`;
    return (this.db.prepare(sql).all(...values) as StoredTask[]).map((row) => this.toTask(row));
  }

  async update(id: string, patch: Partial<AgentTask>, expectedRevision?: number): Promise<AgentTask> {
    const current = await this.get(id);
    if (current === undefined) throw new Error(`Unknown task: ${id}`);
    if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new Error(`Task revision conflict: ${id}`);
    const next = agentTaskSchema.parse({ ...current, ...patch, revision: current.revision + 1, updatedAt: patch.updatedAt ?? new Date().toISOString() });
    const result = this.db.prepare(`UPDATE agent_tasks SET parent_task_id=?,session_id=?,created_by=?,assigned_agent_id=?,objective=?,input=?,output_references=?,memory_references=?,artifact_references=?,dependency_ids=?,status=?,failure_policy=?,attempt=?,revision=?,lease_until=?,worker_id=?,created_at=?,updated_at=?,max_attempts=?,metadata=? WHERE id=? AND revision=?`).run(
      next.parentTaskId ?? null, next.sessionId, next.createdBy, next.assignedAgentId ?? null, next.objective, JSON.stringify(next.input), JSON.stringify(next.outputReferences), JSON.stringify(next.memoryReferences), JSON.stringify(next.artifactReferences), JSON.stringify(next.dependencyIds), next.status, next.failurePolicy, next.attempt, next.revision, next.leaseUntil ?? null, next.workerId ?? null, next.createdAt, next.updatedAt, next.maxAttempts, JSON.stringify(next.metadata), id, current.revision,
    );
    if (result.changes !== 1) throw new Error(`Task revision conflict: ${id}`);
    return next;
  }

  async claimReady(workerId: string, now = new Date(), leaseMs = 30_000, sessionId?: string): Promise<AgentTask | undefined> {
    const nowIso = now.toISOString();
    return this.db.transaction(() => {
      this.db.prepare("UPDATE agent_tasks SET status='pending', lease_until=NULL, worker_id=NULL, updated_at=? WHERE status='running' AND lease_until IS NOT NULL AND lease_until <= ?").run(nowIso, nowIso);
      const rows = (sessionId === undefined ? this.db.prepare("SELECT * FROM agent_tasks WHERE status IN ('pending','waiting') AND attempt < max_attempts ORDER BY created_at,id").all() : this.db.prepare("SELECT * FROM agent_tasks WHERE status IN ('pending','waiting') AND attempt < max_attempts AND session_id=? ORDER BY created_at,id").all(sessionId)) as StoredTask[];
      const statuses = new Map((this.db.prepare("SELECT id,status FROM agent_tasks").all() as Array<{ id: string; status: AgentTaskStatus }>).map((row) => [row.id, row.status]));
      const candidate = rows.map((row) => this.toTask(row)).find((task) => task.dependencyIds.every((dependencyId) => statuses.get(dependencyId) === "completed" || (statuses.get(dependencyId) === "failed" && task.failurePolicy === "continue-with-partial")));
      if (candidate === undefined) return undefined;
      const result = this.db.prepare("UPDATE agent_tasks SET status='running', attempt=attempt+1, lease_until=?, worker_id=?, revision=revision+1, updated_at=? WHERE id=? AND status IN ('pending','waiting')").run(new Date(now.getTime() + leaseMs).toISOString(), workerId, nowIso, candidate.id);
      return result.changes === 1 ? this.toTask(this.db.prepare("SELECT * FROM agent_tasks WHERE id=?").get(candidate.id) as StoredTask) : undefined;
    })();
  }

  async recoverExpired(now = new Date()): Promise<number> { return Number(this.db.prepare("UPDATE agent_tasks SET status='pending', lease_until=NULL, worker_id=NULL, revision=revision+1, updated_at=? WHERE status='running' AND lease_until IS NOT NULL AND lease_until <= ?").run(now.toISOString(), now.toISOString()).changes); }
  close(): void { this.db.close(); }

  private toTask(row: StoredTask): AgentTask {
    return agentTaskSchema.parse({ id: row.id, ...(row.parent_task_id === null ? {} : { parentTaskId: row.parent_task_id }), sessionId: row.session_id, createdBy: row.created_by, ...(row.assigned_agent_id === null ? {} : { assignedAgentId: row.assigned_agent_id }), objective: row.objective, input: JSON.parse(row.input), outputReferences: JSON.parse(row.output_references), memoryReferences: JSON.parse(row.memory_references), artifactReferences: JSON.parse(row.artifact_references), dependencyIds: JSON.parse(row.dependency_ids), status: row.status, failurePolicy: row.failure_policy, attempt: row.attempt, revision: row.revision, ...(row.lease_until === null ? {} : { leaseUntil: row.lease_until }), ...(row.worker_id === null ? {} : { workerId: row.worker_id }), createdAt: row.created_at, updatedAt: row.updated_at, maxAttempts: row.max_attempts, metadata: JSON.parse(row.metadata) });
  }
}
