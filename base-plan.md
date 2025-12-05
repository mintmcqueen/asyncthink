# AsyncThink: Sequential Thinking + Async Workers

## Goal
Create a new unified server at `async-think/asyncthink/` that:
1. Preserves sequential thinking as the continuous "stream of thought"
2. Adds async worker forking capability via **Claude Code subprocess** (`claude --print`)
3. **Retains auto-decomposition** (keeps Claude's thought stream clean)
4. Returns worker status reminders on each thought

**Key insight**: Claude Code workers (via `claude --print <prompt>`) are FREE (subscription-based) and can do EVERYTHING - repo search, file reading, web search. This is strictly superior to Gemini workers.

## Worker Implementation

**Inspired by claudecode-mcp-async, rebuilt from scratch in TypeScript.**

We adopt the core pattern from [jeanchristophe13v/claudecode-mcp-async](https://github.com/jeanchristophe13v/claudecode-mcp-async) (Python) but implement it natively in TypeScript using Node.js `child_process`:

```typescript
import { spawn } from 'child_process';

const proc = spawn('claude', ['--print', prompt], {
  cwd: workingDirectory,
  detached: true,
  stdio: ['ignore', stdout_fd, stderr_fd]
});
proc.unref(); // Don't wait for child
```

**Key principles from claudecode-mcp-async:**
- Spawn via `claude --print <prompt>` (non-blocking)
- Task state persisted to filesystem (`~/.local/share/asyncthink/tasks/{id}/`)
- Process isolation via `detached: true` + `start_new_session`
- Result retrieval by reading stdout file

**NOT using the Python package** - this is a ground-up TypeScript implementation following the same architectural pattern.

## Location
```
async-think/
├── asyncthink-mcp/    # KEEP (deprecate later)
├── sequentialthinking/ # KEEP (reference only)
└── asyncthink/        # NEW - copy sequentialthinking, extend with workers
```

## Architecture

```
async-think/asyncthink/
├── src/
│   ├── index.ts              # MCP server entry (single tool: asyncthink)
│   ├── lib/
│   │   ├── thinking.ts       # Sequential thinking (from sequentialthinking/lib.ts)
│   │   ├── orchestrator.ts   # Spawns organizer worker, tracks top-level state
│   │   ├── ledger.ts         # Research state tracking (fault-proof)
│   │   └── config.ts         # XDG config (from asyncthink-mcp)
│   ├── prompts/
│   │   └── organizer.ts      # Prompt template for organizer worker
│   └── types/
│       └── index.ts
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

**Note**: The organizer worker (Claude Code subprocess) handles decomposition + sub-worker spawning internally. The MCP server just spawns it and tracks results.

**Flow:**
1. Claude calls `asyncthink` with `forkResearch: {id, topic}`
2. MCP server spawns a **Claude Code organizer worker** to decompose the topic
3. Organizer worker intelligently uses tools based on query type:
   - **Read/Grep** → repo/codebase investigations (direct, no sub-agents)
   - **mcp__gemini__chat** → general knowledge, synthesis, reasoning
   - **WebSearch/WebFetch** → current events, web research
   - **reporag, Context7, WebSearch/Fetch** → documentation research
4. Ledger tracks status per research ID (all sub-workers)
5. On subsequent calls, OUTPUT includes `research.completed` + `reminder`
6. Claude uses `readResearch` to inject aggregated results

**Worker Hierarchy:**
```
asyncthink MCP server
└── Claude Code Organizer Worker (spawned via `claude --print`)
    ├── Read/Grep: "Find where X is implemented" (direct tool use)
    ├── mcp__gemini__chat: "Explain concept Y"
    ├── WebSearch: "Latest news on Z"
    └── reporag/Context7: "Documentation for library W"
```

The organizer worker:
1. Decomposes the topic into sub-queries
2. Uses appropriate tools directly (Read/Grep for repo, Gemini for knowledge, etc.)
3. Aggregates and returns structured JSON results

## Tool Interface

**Important**: INPUT and OUTPUT are SEPARATE structures. The tool receives input, processes it, and returns a different output.

### INPUT Schema (what Claude sends TO the tool)
```typescript
{
  // Sequential thinking core (PRESERVED AS-IS)
  thought: string;
  thoughtNumber: number;
  totalThoughts: number;
  nextThoughtNeeded: boolean;
  isRevision?: boolean;
  revisesThought?: number;
  branchFromThought?: number;
  branchId?: string;
  needsMoreThoughts?: boolean;

  // NEW: Fork research (auto-decomposed into Claude Code workers)
  forkResearch?: {
    id: string;           // Unique ID for this research task
    topic: string;        // Topic to research (auto-decomposed by organizer)
    workerCount?: number; // Number of workers (default: 3)
    hint?: string;        // Optional decomposition hint
  };

  // NEW: Explicitly read completed research result
  readResearch?: string;  // Research ID to inject

  // NEW: Block until research completes
  waitFor?: string[];     // Research IDs to wait for
}
```

### OUTPUT Schema (what tool returns TO Claude)
```typescript
{
  // Sequential thinking (PRESERVED AS-IS - computed from input + state)
  thoughtNumber: number;
  totalThoughts: number;
  nextThoughtNeeded: boolean;
  branches: string[];           // Computed from branch history
  thoughtHistoryLength: number; // Computed from thought history

  // NEW: Research status (computed from ledger)
  research: {
    pending: string[];    // Research IDs still running
    completed: string[];  // Research IDs ready to read
  };

  // NEW: Injected results (if readResearch or waitFor used)
  researchResults?: Array<{
    id: string;
    topic: string;
    workers: Array<{
      subQuery: string;
      result: string;
    }>;
  }>;

  // NEW: Reminder (always present if research exists)
  reminder?: string;  // e.g., "Research 'rust-vs-go' completed. Use readResearch."
}
```

## Source Files

### From sequentialthinking/ (copy as base)
| Source | Destination | Changes |
|--------|-------------|---------|
| `lib.ts` | `src/lib/thinking.ts` | Add orchestrator integration |
| `index.ts` | `src/index.ts` | Extend schema with fork/read/wait |
| `package.json` | `package.json` | Add dependencies |
| `tsconfig.json` | `tsconfig.json` | Copy as-is |

### From asyncthink-mcp/ (copy selectively)
| Source | Destination | Changes |
|--------|-------------|---------|
| `src/lib/config.ts` | `src/lib/config.ts` | Reuse XDG config |

### New Files
| File | Purpose |
|------|---------|
| `src/lib/orchestrator.ts` | Spawns organizer worker, reads results |
| `src/lib/ledger.ts` | Task state tracking with file persistence |
| `src/prompts/organizer.ts` | Prompt template for organizer worker |

**Key insight**: The MCP server is thin - it just spawns a Claude Code "organizer worker" with a detailed prompt. The organizer worker handles all the complexity (decomposition, sub-worker spawning, tool selection).

### Organizer Worker Prompt (src/prompts/organizer.ts)
The organizer worker receives a prompt like:
```
You are an async research organizer. Your task: "{topic}"

Decompose this into independent sub-queries. For each sub-query, use the appropriate tool:
- **Read/Grep** → repo/codebase investigations (search code, read files)
- **mcp__gemini__chat** → general knowledge, synthesis, reasoning
- **WebSearch/WebFetch** → current events, web research
- **mcp__repo-rag, mcp__context7, WebSearch/Fetch** → documentation research

Execute sub-queries using the tools directly. Return a structured JSON summary of findings.
```

The organizer worker is a full Claude Code session - it has access to ALL MCP tools and uses them directly (no sub-agents).

## Implementation Steps

### Phase 1: Bootstrap (copy sequentialthinking)
```bash
cd <project-root>
mkdir asyncthink
cp -r sequentialthinking/* asyncthink/
cd asyncthink
# Rename and restructure
mkdir -p src/lib src/prompts src/types
mv lib.ts src/lib/thinking.ts
mv index.ts src/index.ts
```

### Phase 2: Copy from asyncthink-mcp
```bash
cp ../asyncthink-mcp/src/lib/config.ts src/lib/
```

### Phase 3: Create New Files

1. **`src/lib/orchestrator.ts`** - Spawns organizer worker:
   ```typescript
   import { spawn } from 'child_process';
   import { getLedger } from './ledger.js';

   export async function spawnOrganizerWorker(
     researchId: string,
     topic: string,
     hint?: string
   ): Promise<void> {
     const ledger = getLedger();
     const taskDir = ledger.createTask(researchId, topic);

     const prompt = formatOrganizerPrompt(topic, hint);
     const proc = spawn('claude', ['--print', prompt], {
       cwd: process.cwd(),
       detached: true,
       stdio: ['ignore',
         fs.openSync(`${taskDir}/stdout`, 'w'),
         fs.openSync(`${taskDir}/stderr`, 'w')]
     });
     proc.unref();

     ledger.updateTask(researchId, { pid: proc.pid, status: 'running' });
   }
   ```

2. **`src/lib/ledger.ts`** - Task state tracking with file persistence

3. **`src/prompts/organizer.ts`** - Organizer worker prompt template:
   ```typescript
   export function formatOrganizerPrompt(topic: string, hint?: string): string {
     return `You are an async research organizer. Your task: "${topic}"
   ${hint ? `\nHint: ${hint}` : ''}

   Decompose this into 2-4 independent sub-queries. For each, use the appropriate tool DIRECTLY:
   - **Read/Grep** → repo/codebase investigations (search code, read files)
   - **mcp__gemini__chat** → general knowledge, reasoning, synthesis
   - **WebSearch/WebFetch** → current events, web research
   - **mcp__repo-rag, mcp__context7, WebSearch/Fetch** → documentation research

   Execute sub-queries using tools directly (no sub-agents).

   Return ONLY a JSON object with this structure:
   {
     "subQueries": [
       {"type": "repo|gemini|web|docs", "query": "...", "result": "..."},
       ...
     ],
     "synthesis": "Brief synthesis of all findings"
   }`;
   }
   ```

4. **`src/types/index.ts`** - Merged types (ST + asyncthink)

### Phase 4: Extend Tool
1. Update `src/index.ts` - Extended INPUT schema with forkResearch/readResearch/waitFor
2. Update `src/lib/thinking.ts` - Integrate ledger, compute OUTPUT with research status
3. Write comprehensive tool description

### Phase 5: Tool Description
Include:
- When to fork (multi-faceted research questions)
- Organizer worker uses tools directly:
  - Read/Grep for repo investigations
  - Gemini for general knowledge
  - WebSearch for current events
  - reporag/Context7 for documentation
- Workflow: fork → continue thinking → check OUTPUT → readResearch
- Example patterns

### Phase 6: Testing
1. Unit tests for thinking logic (from sequentialthinking)
2. Unit tests for ledger
3. Unit tests for orchestrator (mock subprocess)
4. E2E test with real Claude Code subprocess
5. Integration test with Claude (manual)

## Critical Design Decisions

1. **Auto-decomposition by organizer worker** - Claude Code subprocess handles decomposition + tool selection
2. **Organizer uses tools directly (no sub-agents)**:
   - Read/Grep → repo/codebase investigations
   - mcp__gemini__chat → general knowledge
   - WebSearch/WebFetch → web research
   - reporag/Context7 → documentation
3. **TypeScript implementation** - Inspired by claudecode-mcp-async (Python), rebuilt from scratch
4. **Single organizer worker** - No nested Task agents, just direct tool use
5. **Robust ledger** - XDG-compliant persistence at `~/.local/share/asyncthink/`
6. **Reminder in OUTPUT** - Always present when research exists
7. **Sequential thinking preserved** - All existing ST features work unchanged
8. **MCP server is thin** - Complexity delegated to organizer worker prompt

## Worker Limit (from paper)

The AsyncThink paper (lines 150, 165) states:
- Agent pool capacity = `c`
- Workers = `c-1` (organizer occupies 1 slot)
- With c=4: **max 3 workers per research task**

This is **per research task**. Multiple concurrent research tasks each get up to 3 workers.

## Sequential Thinking Patterns (must preserve)

From sequentialthinking tool description:
1. **Hypothesis generation** - Form testable hypotheses
2. **Hypothesis verification** - Check against evidence
3. **Uncertainty expression** - "I'm uncertain about X"
4. **Revision** - `isRevision: true, revisesThought: N`
5. **Branching** - `branchFromThought: N, branchId: "alt"`
6. **Course correction** - Adjust approach mid-stream
7. **Filtering** - Ignore irrelevant information

## Simulation: Rust vs Go Question (10 thoughts)

```
T1: "The user asks about Rust vs Go for microservices. Key factors: performance,
    productivity, ecosystem, hiring. Need data on each."
    → forkResearch: {id: "perf", topic: "Rust vs Go performance benchmarks..."}
    → Response: research.pending: ["perf"]

T2: "While research runs, I should think about what 'performance' means here:
    p99 latency, memory footprint, startup time. My hypothesis: Go's goroutines
    might be more efficient for I/O-bound workloads."
    → forkResearch: {id: "dx", topic: "Rust vs Go developer experience..."}
    → Response: research.pending: ["perf", "dx"]

T3: "I realize I'm making assumptions about the team's expertise. If they're from
    Python, Go might be easier. C++ background favors Rust ownership model.
    Missing context - continue with general analysis."
    → No fork
    → Response: research.completed: ["perf"] ← first done!

T4: "Let me read the performance research before continuing."
    → readResearch: "perf"
    → Response: researchResults injected (3 workers worth of data)

T5: [REVISION of T2] "The Discord case study contradicts my I/O hypothesis.
    It's not I/O vs CPU - it's about GC pauses causing tail latency. Rust's
    zero-GC wins for consistent p99."
    → isRevision: true, revisesThought: 2
    → Response: research.completed: ["dx"]

T6: "Reading DX research to complete the picture."
    → readResearch: "dx"
    → Response: researchResults injected

T7: "Synthesis hypothesis: Go for most services (faster dev, easier hiring),
    Rust for perf-critical paths. This is Cloudflare's approach. But I'm
    uncertain: is hybrid practical for small teams?"

T8: [BRANCH] "Alternative path: what if team goes all-in Rust? Discord/Figma
    did this. Break-even might be 6-12 months, then long-term benefits."
    → branchFromThought: 7, branchId: "all-rust"

T9: "Verifying hypothesis: (1) Performance: Rust wins ✓ (2) Productivity:
    Go wins short-term ✓ (3) Hiring: Go easier ✓ (4) Ecosystem: Go owns
    cloud-native ✓. Framework: team<10 && timeline<2yr → Go."

T10: "Final: Decision framework based on team size, timeline, perf requirements.
     Hybrid as default. Note uncertainty on long-term Rust productivity."
     → nextThoughtNeeded: false
```

**Key patterns demonstrated:**
- Thoughts contain actual reasoning, not meta-description
- Research forks don't interrupt flow
- Revision happens when evidence contradicts hypothesis (T5)
- Branch explores alternative (T8)
- Uncertainty expressed naturally (T7)

## Ledger Design (Critical)

The ledger must be **robust and fault-proof**:

```typescript
interface WorkerLedger {
  workers: Map<string, {
    id: string;
    query: string;
    status: 'pending' | 'running' | 'complete' | 'failed';
    forkThought: number;
    forkTime: Date;
    completeTime?: Date;
    result?: string;
    error?: string;
    sources?: string[];
  }>;
}
```

**Fault tolerance:**
- In-memory primary (fast)
- File backup at `~/.local/share/asyncthink/ledger.json` (XDG compliant)
- Write-through on state changes
- Recovery on server restart
- Worker timeout handling (60s default)

## Defaults

- Worker timeout: 120s (Claude Code may need more time than Gemini)
- **Max concurrent workers: 3** (per paper recommendation)
- Default workers per research: 3
- Task storage: `~/.local/share/asyncthink/tasks/`
- Worker command: `claude --print <sub-query>`
