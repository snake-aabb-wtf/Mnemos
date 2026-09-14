# Dual-Agent Cognitive Harness

## 1. 项目定位

本项目是一个面向长期运行 AI Agent 的 Cognitive Harness Runtime。

它的目标不是简单扩大模型上下文，而是把模型自身 Context Window 视为有限的 **Working Set**，再通过：

- 长期 Memory
- 原始 History
- Pinned Context
- Working State
- Artifact Store
- RAG
- Programmatic Tool Calling
- Dynamic Tool Discovery
- Hidden Memory Agent

让一个上下文只有 128k 的主 Agent，在长期运行中能够访问和利用远超 128k 的信息。

核心思想：

> Context 是当前意识窗口，而不是整个大脑。

---

# 2. Agent 架构

系统包含两个主要 Agent。

## 2.1 Visible Agent

Visible Agent，即主 Agent。

职责：

- 与用户直接交互
- 推理
- 回答问题
- 调用工具
- 执行任务
- 主动检索长期记忆
- 使用 PTC 编排复杂工具链
- 管理当前任务状态

默认 Context Window：

```text
128k tokens
```

它不应该长期携带全部历史。

理想状态：

```text
System / Harness Instructions
+
Pinned Context
+
Retrieved Memory
+
Recent Raw Context
+
Tool Results
+
Output Reserve
```

其中最近原始对话目标约为：

```text
48k tokens
```

具体值必须配置化。

---

## 2.2 Hidden Agent

Hidden Agent 不与用户直接交流。

它拥有更大的 Context Window，目标约：

```text
1M tokens
```

主要负责：

- 阅读被 Visible Agent 驱逐的历史
- 提取长期有效信息
- 更新长期 Memory
- 去重
- 冲突检测
- supersede 旧记忆
- 建立实体关系
- 维护索引
- 从多次事件中形成更稳定的长期认知

Hidden Agent 是 Memory Consolidation Agent，而不是第二个聊天 Agent。

---

# 3. 信息分层

系统必须严格区分以下五个概念。

## 3.1 Context

模型当前实际看到的内容。

特点：

- 临时
- 昂贵
- Token 有限
- 可以被重建
- 不是 Source of Truth

---

## 3.2 History

完整原始历史。

包括：

- user messages
- assistant messages
- tool calls
- tool results
- runtime events
- source metadata

原则：

> History is the source of truth.

History 应尽量 append-only。

Compaction 绝不能删除原始 History。

---

## 3.3 Memory

由历史派生出的长期认知。

例如：

```text
用户正在开发一个双 Agent Harness。
用户决定 Visible Agent 使用 128k 上下文。
项目采用 TypeScript。
```

Memory：

- 可以更新
- 可以被推翻
- 可以产生错误
- 必须能追溯原始 History
- 不能替代 History

原则：

> Memory is derived and fallible.

---

## 3.4 State

State 描述：

> Agent 现在正在干什么。

例如：

```json
{
  "currentTask": "Implement Phase 2 context compaction",
  "currentPlan": [
    "boundary selection",
    "summary generation",
    "eviction pipeline"
  ],
  "openIssues": [
    "tool transaction boundary"
  ]
}
```

State 不等于 Memory。

---

## 3.5 Artifact

Artifact 是不适合直接进入模型 Context 的大型中间数据。

例如：

- 50MB 日志
- 搜索结果
- AST
- 大型 diff
- 大型 JSON
- 网页抓取结果
- 数据库结果
- PTC 中间数据

模型看到 Handle：

```text
artifact://session/abc123
```

而不是所有原始数据。

---

# 4. 总体架构

```text
                           USER
                             │
                             ▼
                    ┌────────────────┐
                    │ Visible Agent  │
                    │     128K       │
                    └───────┬────────┘
                            │
             ┌──────────────┼───────────────┐
             │              │               │
             ▼              ▼               ▼
          Direct        Native Tool        PTC
          Answer            Call           Runtime
                                               │
                              ┌────────────────┼─────────────┐
                              ▼                ▼             ▼
                            Memory           Files         Tools
                              │
                              ▼
                      Retrieval Layer
                              │
             ┌────────────────┼────────────────┐
             ▼                ▼                ▼
           Vector            BM25            Entity
             └────────────────┼────────────────┘
                              ▼
                         Memory Store
                              ▲
                              │
                        Consolidation
                              │
                    ┌─────────┴─────────┐
                    │   Hidden Agent    │
                    │       ~1M         │
                    └─────────▲─────────┘
                              │
                       Evicted History
                              │
                    ┌─────────┴─────────┐
                    │ Context Manager   │
                    └───────────────────┘
```

---

# 5. Context Management

Visible Agent 的 128k 不应该真的跑到 128k 才处理。

建议保留大量 headroom。

一个典型预算：

```text
System                     8–12k
Pinned Context            10–20k
Recent Raw Context           ~48k
Retrieved Memory           8–16k
Tool Results               8–16k
Generation / reserve         20k+
```

这不是固定分区，而是动态预算。

---

# 6. Context Pressure

Context Manager 应输出：

```ts
interface ContextStats {
  usedTokens: number;
  contextLimit: number;

  systemTokens: number;
  pinnedTokens: number;
  recentRawTokens: number;
  artifactHandleTokens: number;
  toolSchemaTokens: number;
  retrievedMemoryTokens: number;
  toolResultTokens: number;

  reservedTokens: number;

  pressure: number;
}
```

推荐默认阈值：

```text
< 0.60
normal

0.60–0.75
soft pressure

0.75–0.85
prefer artifact/PTC/selective retrieval

0.85+
compaction

0.92+
emergency compaction
```

所有数字配置化。

---

# 7. Compaction

不要机械执行：

```text
前 80k → summarize
后 48k → retain
```

80k 只是目标。

真正 cutoff 应寻找合适的逻辑边界。

优先考虑：

1. task boundary
2. user/assistant turn boundary
3. tool transaction boundary
4. message boundary
5. token boundary

例如：

```text
target cutoff = 80k
allowed search range = 72k–88k
```

在范围内寻找最合理的 cutoff。

---

# 8. Pinned Context

Pinned Context 是当前仍有效的压缩状态，不是聊天摘要。

例如：

```markdown
# Current Goal

Build dual-agent cognitive harness.

# Current Decisions

- TypeScript implementation
- Visible Agent context limit: 128k
- Recent raw context target: ~48k
- Hidden Agent handles memory consolidation
- History remains canonical source
- PTC will be supported

# Open Questions

- Final embedding provider
- Production PTC isolation method
```

Pinned Context 来源：

```text
system pin
automatic compaction pin
visible-agent pin
```

Visible Agent 自己 pin 的内容必须有限额。

---

# 9. Long-Term Memory

Memory 至少逻辑区分：

```text
Semantic Memory
Episodic Memory
Decision Memory
Preference Memory
Entity Memory
```

基本数据结构：

```ts
interface MemoryRecord {
  id: string;

  type:
    | "semantic"
    | "episodic"
    | "decision"
    | "preference"
    | "entity";

  content: string;

  sourceIds: string[];

  createdAt: string;
  updatedAt: string;
  lastConfirmedAt?: string;

  importance: number;
  confidence: number;

  sourceType:
    | "explicit_user_statement"
    | "tool_observation"
    | "assistant_inference"
    | "derived_summary";

  status:
    | "active"
    | "provisional"
    | "superseded"
    | "archived";

  supersededBy?: string;

  entities?: string[];
  tags?: string[];
}
```

---

# 10. Memory Consolidation

Hidden Agent 处理：

```text
Observe
  ↓
Extract
  ↓
Retrieve existing memories
  ↓
Compare
  ↓
Reconcile
  ↓
Persist
  ↓
Index
```

每个候选信息分类为：

```text
new
duplicate
update
contradiction
supersede
irrelevant
```

例如：

旧：

```text
项目准备使用 SQLite
```

新：

```text
项目决定迁移 PostgreSQL
```

不能同时成为两个 active facts。

应该：

```text
SQLite
status = superseded

PostgreSQL
status = active
```

---

# 11. Memory Source Tracing

所有 Memory 必须可以：

```text
Memory
↓
sourceIds
↓
Original History
```

主 Agent 在需要核查时可以读取原始材料。

这是防止 Summary Drift 的核心机制。

---

# 12. Memory Retrieval

最终 Retrieval Layer：

```text
Vector Search
+
BM25 / lexical
+
Entity search
+
Metadata filter
+
Recency
↓
Merge
↓
Reranker
↓
Top K
```

不能只依赖 embedding similarity。

---

# 13. Cognitive Tools

Visible Agent 应拥有专门的认知工具。

## Memory

```ts
memory.search()
memory.get()
memory.related()
memory.timeline()
memory.source()
memory.remember()
```

`memory.remember()` 只是提交候选。

Visible Agent 不直接修改 canonical Memory。

---

## History

```ts
history.search()
history.get()
```

Memory 搜不到或者需要原始证据时使用。

---

## Context

```ts
context.inspect()
context.pin()
context.unpin()
```

---

## State

```ts
state.get()
state.set()
state.patch()
```

---

## Artifact

```ts
artifact.create()
artifact.get()
artifact.query()
artifact.delete()
```

---

# 14. Programmatic Tool Calling

复杂工具任务使用 PTC。

三种执行模式：

```text
native
ptc
both
```

简单：

```text
read package.json
```

使用 native tool。

复杂：

```text
搜索历史
→ 找 20 条结果
→ 过滤
→ 获取其中 5 条原文
→ 与当前代码比较
→ 返回差异
```

使用 PTC。

both 同时暴露 native tools 和 run_code；本阶段不实现自动复杂度 Router，由模型依据版本化 policy 自行选择。

---

# 15. PTC Architecture

```text
Visible Agent
      │
      ▼
   run_code
      │
      ▼
 PTC Runtime
      │
      ▼
Sandboxed Program
      │
      ▼
Generated Tool SDK
      │
      ▼
Tool Dispatcher
      │
      ▼
Permission Layer
      │
      ▼
Actual Tools
```

绝不允许：

```text
run_code -> unrestricted host machine
```

权限永远由 Tool Dispatcher 控制。

---

# 16. PTC Limits

必须限制：

```text
CPU
wall time
memory
number of tool calls
concurrency
network
filesystem
returned bytes
available tools
```

大输出进入 Artifact Store。

Phase 8 的开发期 backend 必须使用单次独立进程、空环境、资源上限和 RPC-only Tool SDK；Node Permission Model 可拒绝 filesystem、child process、worker、addon 和 WASI 能力。当前 Node Permission Model 没有通用的 OS 级 network deny 开关，因此 source-level network/import 拒绝只是 defense in depth，不能宣称为 hostile-code production sandbox。Phase 13 应在同一个 PtcSandbox interface 后提供 Docker、gVisor、Firecracker 或等价的网络隔离后端。

---

# 17. Dynamic Tool Discovery

随着工具数量增长，不能把几百个 Schema 全塞进 System Prompt。

核心模型只长期知道少量元工具，例如：

```text
memory.search
history.search
context.inspect
state.*
artifact.*
tools.search
tools.describe
run_code
```

其他工具：

```text
tools.search
↓
tools.describe
↓
load SDK/schema
↓
native/PTC execution
```

---

# 18. 技术栈

## 18.1 主语言

**TypeScript**

整个 Harness Runtime 使用 TS。

原因：

- 非常适合 Agent/tool schema
- 类型系统适合 Tool Registry
- JSON/schema 生态成熟
- AI SDK 生态丰富
- Node 异步 IO 非常适合 Harness
- PTC 如果也使用 TS，可以共享 Tool SDK 类型
- WebSocket、HTTP、MCP、CLI 都很好接
- 后续做 Web UI 也可以共享类型

---

## 18.2 Runtime

推荐：

```text
Node.js 22+
```

不要以 Bun-only API 为基础。

Bun 可作为可选运行环境，但 Node 是 canonical runtime。

---

## 18.3 Package Manager

```text
pnpm
```

如果以后演化成：

```text
packages/core
packages/memory
packages/ptc
packages/providers
packages/cli
```

pnpm workspace 很合适。

---

## 18.4 Repository

建议从一开始使用 workspace：

```text
apps/
  cli/

packages/
  core/
  providers/
  storage/
```

早期不用拆几十个 package。

避免 monorepo 过度设计。

---

## 18.5 Validation

```text
Zod
```

用于：

- tool parameters
- config
- event payloads
- storage objects
- model responses
- SDK validation

TypeScript 类型负责编译期。

Zod 负责 runtime。

---

## 18.6 Testing

```text
Vitest
```

覆盖：

- unit tests
- integration tests
- simulated long-context tests

所有 Phase Definition of Done 必须可以在没有任何付费模型凭据的离线环境中完成。Core、MemoryStore、MemoryRetriever、Hidden Agent consolidation、source tracing、SQLite persistence、runtime policy 和故障注入测试使用 `MockModelProvider`、scripted deterministic adapters、deterministic embeddings、synthetic workloads 与 fixtures。真实 Provider integration tests（如果保留）只能作为显式的 optional `test:live` 流程；缺少 API key 时必须 SKIP，不能让默认 `pnpm test` 失败，也不能成为 Phase 完成条件。外部模型智能可以 mock，但 Mnemos 自身的 Memory、History、retrieval、consolidation 和 runtime 行为必须真实执行。

---

## 18.7 Logging

```text
Pino
```

结构化日志。

以后可以直接记录：

```text
requestId
sessionId
agentId
toolCallId
ptcExecutionId
memoryId
```

---

## 18.8 Initial Database

MVP：

```text
SQLite
```

推荐：

```text
better-sqlite3
```

初期足够保存：

- History
- Memory
- State
- Event metadata
- Artifact metadata

后面 Storage API 可以迁移 PostgreSQL。

---

## 18.9 ORM

不强制 ORM。

更推荐：

```text
Drizzle ORM
```

或者轻量 SQL Repository。

不要为了 ORM 搞太重。

推荐：

```text
Drizzle + SQLite
```

后续迁移 PostgreSQL 也容易。

---

## 18.10 Vector Search

Phase 早期不实现。

MVP RAG 阶段推荐先尝试：

```text
sqlite-vec
```

这样：

```text
SQLite
+
FTS5
+
sqlite-vec
```

可以同时提供：

```text
structured data
BM25
vector search
```

不需要立刻部署 Qdrant。

规模大以后再支持：

```text
Qdrant
PostgreSQL + pgvector
```

---

## 18.11 Lexical Search

优先：

```text
SQLite FTS5
```

不要第一天自己实现 BM25 engine。

---

## 18.12 Embeddings

建立：

```ts
interface EmbeddingProvider
```

不要绑定厂商。

后续可以接：

```text
OpenAI
Gemini
Voyage
Jina
local embedding models
```

---

## 18.13 Model Provider

统一接口：

```ts
interface ModelProvider
```

未来 adapters：

```text
OpenAI
Anthropic
Gemini
DeepSeek
OpenRouter
OpenAI-compatible
```

核心 runtime 禁止直接依赖厂商 SDK 类型。

---

## 18.14 PTC Runtime

PTC 第一版可以使用：

```text
isolated child process
```

但生产安全版本最终应该走：

```text
container / stronger sandbox
```

禁止把 Node：

```ts
vm.runInContext()
```

当成真正安全边界。

它可以用于可信测试，但不能作为最终安全设计。

候选：

```text
Docker sandbox
Deno restricted subprocess
gVisor
Firecracker
```

具体实现后续 benchmark 后决定。

---

## 18.15 Tool SDK

Tool contract：

```text
Zod schema
↓
JSON Schema
↓
generated TypeScript SDK
```

这样 native tool calling 和 PTC 可以共享同一个 Tool Registry。

---

# 19. 建议目录结构

```text
apps/
  cli/

packages/
  core/
    src/
      agent/
      context/
      runtime/
      events/
      state/

  storage/
    src/
      history/
      memory/
      state/
      artifact/
      sqlite/

  tools/
    src/
      registry/
      dispatcher/
      discovery/
      cognitive/

  retrieval/
    src/
      lexical/
      vector/
      rerank/

  ptc/
    src/
      runtime/
      sandbox/
      sdk/

  providers/
    src/
      model/
      embedding/

tests/
```

第一阶段可以只真正建立：

```text
core
storage
cli
```

后面再拆。

---

# 20. Development Roadmap

---

# Phase 1 — Runtime Foundation

目标：

> 先让 Harness 本身跑起来。

实现：

### Core Runtime

- Harness class
- Visible Agent abstraction
- ModelProvider abstraction
- MockModelProvider

### History

- HistoryStore interface
- SQLite implementation
- message IDs
- append/get/list
- raw history persistence

### State

- StateStore
- get/set/patch

### Context

- ContextManager
- token estimator abstraction
- context budgets
- context pressure
- recent raw selection

### Pinned Context

- basic representation
- add/remove
- token budget

### Events

- EventBus
- message.received
- message.generated
- context.pressure
- context.compaction.requested

### CLI

最小聊天 CLI。

### Tests

完整测试 Runtime 生命周期。

## Phase 1 不实现

- real compaction
- hidden agent
- RAG
- embeddings
- memory consolidation
- PTC
- tool discovery

## Phase 1 DoD

```text
build passes
typecheck passes
tests pass
CLI works
history persists
context accounting works
pressure events work
mock provider completes full conversation
```

---

# Phase 2 — Context Compaction

目标：

> 让 128k Visible Context 真正能够滚动运行。

实现：

- CompactionService
- cutoff search
- semantic-safe boundaries
- tool transaction boundaries
- auto-generated Pinned Context
- recent raw target ~48k
- eviction pipeline
- source IDs
- context.evicted event

要求：

原始 History 永不删除。

建立测试模拟：

```text
200k+
500k+
1M+
```

累计历史。

验证 Visible Context 始终受控。

## Phase 2 DoD

- 可以连续运行超 context 历史
- compaction 后信息结构正确
- raw recent history 保留
- old raw history 仍可从 HistoryStore 获取
- cutoff 不破坏 tool transaction

---

# Phase 3 — Long-Term Memory Foundation

目标：

> 建立真正的长期 Memory。

实现：

- MemoryStore
- MemoryRecord schema
- semantic/episodic/decision/preference/entity memory
- source tracing
- status
- confidence
- importance
- superseded relation

先实现：

```text
SQLite
+
FTS5
```

提供认知工具：

```text
memory.search
memory.get
memory.source
memory.timeline
```

暂时可以没有 embeddings。

## Phase 3 DoD

- Memory 可以独立持久化
- 能从 Memory 找回相关信息
- 每条 Memory 可以追溯 History
- superseded memory 不默认作为当前事实

---

# Phase 4 — Hidden Agent Consolidation

目标：

> 自动把被驱逐历史变成长时记忆。

实现 Hidden Agent。

订阅：

```text
context.evicted
```

流程：

```text
extract
retrieve
compare
reconcile
write
```

必须识别：

```text
new
duplicate
update
contradiction
supersede
irrelevant
```

加入：

```text
memory.remember
```

Visible Agent 可以提交候选记忆，但不能直接写 canonical Memory。

## Phase 4 DoD

模拟多次用户改变决定，例如：

```text
SQLite
→ PostgreSQL
→ PostgreSQL + Redis
```

最终 Memory 的 active 状态必须正确。

---

# Phase 5 — Hybrid Retrieval / RAG

目标：

> 让长期记忆召回达到可用级别。

加入：

```text
embeddings
vector search
FTS5 lexical search
entity lookup
metadata filter
recency score
reranking
```

提供统一：

```ts
memory.search()
```

调用方不关心底层检索方式。

加入 Retrieval Evaluation Dataset。

测试：

- paraphrase
- exact keyword
- old decision
- updated decision
- entity lookup
- temporal query

## Phase 5 DoD

RAG 召回 benchmark 达到预设指标。

---

# Phase 6 — Artifact Store

目标：

> 防止大型工具输出污染 Context。

实现：

```text
artifact.create
artifact.get
artifact.query
artifact.delete
```

支持：

- metadata
- size
- MIME type
- session scope
- lifetime
- local filesystem backing

Tool Dispatcher 支持：

```text
large result
↓
spill to artifact
↓
return handle
```

## Phase 6 DoD

即使工具生成几十 MB 数据，也不会直接塞入模型 Context。

---

# Phase 7 — Tool Runtime

目标：

> 正式建立完整 Tool Infrastructure。

实现：

- ToolRegistry
- Tool schema
- ToolDispatcher
- permissions
- tool execution
- timeout
- auditing
- native model tool calling

首先加入 Harness 自己的工具：

```text
memory.*
history.*
context.*
state.*
artifact.*
```

## Phase 7 DoD

Visible Agent 能稳定调用认知工具完成真实任务。

---

# Phase 8 — Programmatic Tool Calling

目标：

> 支持模型通过代码编排复杂工具流程。

实现：

- PTC Runtime
- generated TypeScript SDK
- code execution sandbox
- tool call quotas
- concurrency
- timeout
- output limits
- Artifact integration

PTC Code 不能绕过 Dispatcher。

支持：

```text
native
ptc
```

两种模式。

## Phase 8 DoD

复杂 20+ tool-call workflow 可以在一次 PTC 执行中完成，而不会把全部中间结果塞回模型 Context。

---

# Phase 9 — Dynamic Tool Discovery

目标：

> 工具数量增加以后，避免 Tool Schema Context 爆炸。

实现：

```text
tools.search
tools.describe
```

Agent 默认只加载核心 Tool Set。

需要 Git、Browser、GitHub 等能力时动态发现。

支持：

```text
tool metadata index
deterministic lexical search (semantic ranking may be added behind the same interface)
schema on demand
```

## Phase 9 DoD

即使 Harness 安装 500+ 工具，主 Agent 初始 prompt 也不需要包含全部 schemas。

Phase 9 的发现入口仍是正式 `ToolDefinition`，并且必须经过 `ToolDispatcher`。`ToolRegistry` 是唯一的定义来源；可重建的 `ToolDiscoveryIndex` 只保存派生元数据和稳定 schema fingerprint。`tools.search` 只返回有界候选元数据，`tools.describe` 按需返回完整 JSON Schema 并加载 session-scoped `LoadedToolSet`。

Loaded Tool Set 具有核心工具白名单、动态工具数量上限、schema token budget、结果字节上限和确定性的 LRU 驱逐。Native、PTC、both 三种模式都只能看到当前快照；PTC SDK 从同一 Registry 快照生成，任何子调用仍由 Dispatcher 做权限和 catalog gate 检查。Discovery 状态变化通过 `tool.discovery.*`、`tool.loaded` 和 `tool.unloaded` 事件记录，不能把完整 schema 或中间结果写入模型可见 History。

首版搜索故意采用可解释的 lexical ranking，不要求 embedding、MCP 或外部连接器；这些能力可以在不改变 `ToolDiscoveryIndex.search` / `ToolDiscoveryRuntime.describe` 契约的情况下后续增加。

---

# Phase 10 — Context Intelligence

目标：

> 让 Visible Agent 对自身上下文具备一定感知能力。

实现：

```text
context.inspect
context.pin
context.unpin
```

Agent 能根据压力选择：

```text
native call
PTC
artifact
memory retrieval
compaction request
```

研究自动 Context Policy。

Phase 10 为 Visible Agent 增加 runtime-owned Context Intelligence，而不是把 `ContextManager` 权限交给模型。`ContextStats` 必须同时报告物理可用空间和扣除 generation reserve 后的 safe headroom；pressure 使用 `NORMAL`、`ELEVATED`、`HIGH`、`COMPACTION`、`EMERGENCY` 五级配置阈值，并通过 session-scoped hysteresis 防止阈值附近反复抖动。

`ContextPolicyEngine` 输出 typed recommendations 和 effective budgets。Recommendation（例如 `prefer_ptc`、`prefer_artifact`、`limit_memory_retrieval`、`unload_unused_dynamic_tools`）与 enforcement 分离；当 preflight 仍无法满足 `usedTokens + generationReserveTokens <= contextLimit` 时，Harness 不得调用 ModelProvider，而应先尝试安全 compaction，最终返回明确 runtime error。

`context.inspect` 只暴露当前 session 的计量快照和 runtime policy；`context.pin` 只能创建有 budget、去重、turn-TTL 的 `visible-agent` pin，`context.unpin` 不能移除 system 或 automatic pin。Pinned Context 继续区分 system、automatic、visible-agent，且不改变 canonical History。`context.request_compaction` 只是受 cooldown/meaningful-range 约束的安全请求。

Retrieval、tool schema、tool result 和 Artifact handle 均必须计入 visible context accounting。高压力时 policy 可降低 retrieval/schema/result effective budgets、卸载未使用 dynamic tools，并建议 PTC/Artifact；所有 reduction 都不能删除 canonical History 或拆开 tool transaction。`context.pressure.changed`、`context.policy.applied`、`context.pin.*` 只在有意义的状态转换时产生，禁止 token 级事件风暴。

Phase 10 不实现 memory decay、entity graph、confidence evolution 或新的 Hidden Agent cognition；这些仍属于 Phase 11。

---

# Phase 11 — Memory Intelligence

增强 Hidden Agent：

- memory decay
- importance reinforcement
- repeated event abstraction
- entity graph
- memory merging
- temporal reasoning
- confidence evolution
- stale memory detection

Memory 不只是“保存摘要”，而开始形成长期认知状态。

Phase 11 的实现保持 `History = canonical source of truth`：reinforcement、decay、stale、merge、abstraction 和 entity graph 都是可重建的派生状态，原始 source references 永不被这些操作删除。`MemoryIntelligenceService` 负责 deterministic policy、validated Hidden Agent proposals、独立证据去重、confidence saturation、type/durability-aware effective scoring、maintenance idempotency、scope checks 与 provenance-preserving transitions；`MemoryStore` 仍只负责持久化，`MemoryRetriever` 消费统一的 intelligence signals。SQLite migrations 为 Phase 10 数据库增加这些派生字段和可重建的 entity/audit projections。Phase 11 的默认测试和 `eval:memory` 完全离线，不进入 Phase 12 的 reliability/evaluation campaign。

---

# Phase 12 — Reliability & Evaluation

构建完整 benchmark。

测试至少包括：

### Long conversation

```text
1k turns
10k turns
```

### Memory

- recall
- contradiction
- supersede
- forgotten detail
- source tracing

### Context

- repeated compaction
- context overflow
- giant tool result

### PTC

- 100+ subcalls
- concurrency
- timeout
- crash
- permission escape

### Recovery

- Hidden Agent crash
- vector DB rebuild
- artifact loss
- interrupted compaction

---

Phase 12 的可靠性验证保持完全离线：默认测试和 `eval:reliability` / `eval:soak` 使用
`MockModelProvider`、scripted/deterministic providers、deterministic embeddings、seeded synthetic workloads、
simulated clocks 与 `FaultInjectionController`，不要求任何 API key。真实 provider 测试若存在只能显式运行，
缺少凭据时必须 SKIP，不能成为 Phase 12 Definition of Done 的前置条件。测试真实执行 History、Context、
Memory、Retrieval、Artifact、Tool Runtime、PTC、Discovery 与 SQLite recovery，不 mock 掉 Mnemos 自身。

当前 Phase 12 已实现可复用 `ReliabilityInvariant` 检查、`SyntheticConversationGenerator`、fault schedule、
normalized replay snapshot，以及 1k-turn reliability evaluation 和显式 10k-turn soak。验证覆盖 canonical
History 保留、compaction replay/recovery、Memory provenance、Artifact orphan detection、durable job retry、
subscriber failure isolation 与上下文上限。它是 deterministic correctness/回归基线，不是 Phase 13 的生产级
分布式可靠性、认证、外部 metrics、durable worker platform 或更强的 sandbox 隔离。

---

# Phase 13 — Production Hardening

实现：

- durable queue
- migrations
- metrics
- tracing
- concurrency control
- task isolation
- provider retry
- cost accounting
- token accounting
- auth
- encrypted secrets
- production PTC sandbox

---

Phase 13 的实现保持 no-API-key policy：默认测试、全部离线 eval 与 operational checks 使用 mock/scripted provider
和本地 SQLite/runtime 组件；真实 provider smoke test 只能显式运行，缺少 credentials 时 SKIP。当前已建立
集中 validated `RuntimeConfig`（defaults → config file → known environment overrides → explicit overrides）、
`SecretProvider`/redaction、WAL + busy-timeout 的 SQLite 配置、通用 durable job lease/worker、持久 compact tool
audit、migration runner、provider retry/backoff/jitter/circuit/rate-limit/usage abstractions、metrics/tracing、
liveness/readiness、doctor/migrate/rebuild-indexes/diagnostics 操作入口，以及 `PtcSandboxBackend` capability
contract。Artifact store 支持 committed-body byte quota，只有过期 Artifact 可由 retention cleanup 删除。开发
subprocess 明确标记为 development boundary；`ContainerSandboxBackend` 在 Docker/image runner 不可用时 fail
closed，不将 Node subprocess 虚假宣传为 hostile-code production isolation。

Phase 13 的 CI 仍运行 Phase 1–12 全部 build/typecheck/test/eval/soak。Phase 14 的 Multi-Agent planner、
researcher、coder、reviewer 等 cognition 尚未实现。

---

# Phase 14 — Multi-Agent Extensions

到这个阶段才考虑扩展：

```text
planner
researcher
coder
reviewer
memory agent
```

但它们全部共享 Harness 的：

```text
History
Memory
Artifact
Tool Runtime
State
```

避免每个 Agent 各造一套记忆系统。

---

# 21. 核心不可违反原则

1. Context is a cache, not a database.
2. History is the canonical source of truth.
3. Memory is derived and can be wrong.
4. Memory must retain source references.
5. Compaction must never destroy History.
6. Hidden Agent failure must never cause data loss.
7. State is not Memory.
8. Artifact is not Context.
9. Large intermediate results should remain outside Context.
10. PTC cannot bypass Tool Dispatcher.
11. Tool permissions belong to the runtime, not generated code.
12. Model providers must be replaceable.
13. Storage implementations must be replaceable.
14. RAG implementation must be replaceable.
15. Visible Agent should retrieve rather than carry everything.
16. The Harness is the persistent cognitive system; the LLM is a replaceable reasoning engine.

---

# 22. 最终目标

最终，一个 Visible Agent 即使只有：

```text
128k context
```

依然可以在极长时间尺度上利用：

```text
gigabytes of history
large memory stores
thousands of artifacts
hundreds of tools
large codebases
long-running projects
```

它不需要把这些全部放进 Context。

它只需要：

```text
知道自己现在在做什么
知道什么时候需要回忆
知道如何寻找记忆
知道如何追溯原始证据
知道什么时候把大型数据放到外部
知道什么时候使用程序化工具调用
```

因此：

> 128k 是 Agent 的意识窗口，而不是 Agent 的知识上限。
