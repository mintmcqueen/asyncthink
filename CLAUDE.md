# AsyncThink MCP Server - Developer Documentation

**Version 1.0.0** - Sequential Thinking + Hybrid Async Research Workers

## System Overview & Current Status

**Core Purpose**: MCP server combining Sequential Thinking with async research workers. Claude Code spawns parallel workers for research while continuing its thinking process, then injects results when ready.

**Architecture**: TypeScript MCP server with hybrid worker model:
- **Claude Code workers** (45-90s): Full capability subprocesses via `claude --print`
- **Gemini workers** (2-5s): Direct API calls for fast feedback/web research

**Current Status**: Production-ready with full hybrid worker support

## Critical Data Flow

### Primary Flow: Sequential Thinking + Async Research
```
Claude Code Session
    │
    ├──► asyncthink Tool Call (thought + forkResearch)
    │       │
    │       ├──► processThought() → update history, format output
    │       │
    │       └──► forkResearch handler
    │               │
    │               ├── type: "claude" ──► spawnOrganizerWorker()
    │               │                           │
    │               │                           └──► spawn("claude", ["--print", prompt])
    │               │                                    └──► writes stdout to taskDir
    │               │
    │               └── type: "gemini" ──► executeGeminiWorker()
    │                                           │
    │                                           └──► GeminiClient.generateContent()
    │                                                    └──► direct API, writes result immediately
    │
    ├──► (Claude continues thinking while workers run)
    │
    ├──► asyncthink Tool Call (thought + waitFor/readResearch)
    │       │
    │       ├──► checkAndCollectResults() → poll for completed workers
    │       │
    │       └──► ledger.getResult() → inject into output
    │
    └──► Final Thought (nextThoughtNeeded: false)
            │
            ├──► Auto-wait for ALL pending research
            ├──► Auto-inject ALL completed results
            └──► Cleanup session tasks from ledger
```

### Session Isolation Flow
```
Server Start
    │
    └──► Generate SESSION_ID: "sess_{timestamp}_{random}"
            │
            ├──► All task IDs scoped: SESSION_ID::userProvidedId
            │
            └──► Cleanup filters by session prefix
```

## Version History & Key Enhancements

**v1.0.1** - Sequential Thinking Preservation & Gemini Fix
- Fixed Gemini grounded search: `tools` must be inside `config` object per @google/genai SDK
- Restructured tool description to preserve original sequential thinking instructional style
- Inlined `ThoughtInput` type into `thinking.ts` (removed `src/types/` barrel)
- Tool description now ~65 lines (was 120), preserving original structure + minimal async docs

**v1.0.0** - Hybrid Workers
- Gemini workers for fast feedback (`src/lib/gemini-client.ts`)
- Worker type routing in handler (`src/index.ts:274-300`)
- Configuration tool (`asyncthink_config`)
- `.env.example` for API keys

**v0.9.0** - Session Isolation
- SESSION_ID scoping for concurrent session safety
- Auto-cleanup on final thought
- Failed task visibility in output

**v0.8.0** - Core Implementation
- Sequential thinking integration
- Claude Code subprocess workers
- XDG-compliant persistence
- Ledger state management

## Component Architecture & Dependencies

### Entry Point
- **`src/index.ts`** (663 lines) - MCP server setup, tool registration
  - **Dependencies**: `thinking.ts`, `ledger.ts`, `orchestrator.ts`, `config.ts`, `gemini-client.ts`
  - **Purpose**: Register `asyncthink` and `asyncthink_config` tools, handle all requests
  - **Key Functions**:
    - `scopeTaskId()` / `unscopeTaskId()` - Session ID management (lines 54-71)
    - Tool handler (lines 245-499) - Main request processing
    - Config tool handler (lines 546-644) - Configuration management

### Business Logic Layer
- **`src/lib/thinking.ts`** (110 lines) - Sequential thinking core
  - **Dependencies**: `chalk`
  - **Purpose**: Thought processing, history, branching; exports `ThoughtInput` type
  - **Key Class**: `AsyncThinkingServer`
    - `processThought()` - Main entry point (line 48)
    - `formatThought()` - Console formatting (line 20)

- **`src/lib/orchestrator.ts`** (414 lines) - Worker spawning and management
  - **Dependencies**: `ledger.ts`, `config.ts`, `gemini-client.ts`, `prompts/organizer.ts`
  - **Purpose**: Spawn/execute workers, collect results
  - **Key Functions**:
    - `spawnOrganizerWorker()` - Claude Code subprocess (line 40)
    - `executeGeminiWorker()` - Fast Gemini API call (line 128)
    - `checkAndCollectResults()` - Poll for completed workers (line 314)
    - `checkTimeouts()` - Handle timed-out workers (line 378)

- **`src/lib/gemini-client.ts`** (236 lines) - Gemini API client
  - **Dependencies**: `@google/genai`, `config.ts`
  - **Purpose**: Direct Gemini API calls with grounded search
  - **Key Class**: `GeminiClient`
    - `generateContent()` - Main API call (line 111)
    - `isAvailable()` - Check for API key (line 213)

### Data Layer
- **`src/lib/ledger.ts`** (489 lines) - Task state persistence
  - **Dependencies**: `config.ts`
  - **Purpose**: Track task states, persist to XDG path
  - **Key Class**: `Ledger`
    - `createTask()` - Initialize task (line 201)
    - `updateTask()` - Update state (line 231)
    - `getResult()` - Parse completed result (line 419)
    - `cleanupStaleTasks()` - Recover orphaned tasks (line 133)

- **`src/lib/config.ts`** (333 lines) - Configuration management
  - **Dependencies**: `fs`, `os`, `path`
  - **Purpose**: XDG-compliant config, runtime settings
  - **Key Class**: `ConfigManager`
    - `get()` / `getValue()` - Read config
    - `update()` - Persist changes
    - `ensureDirectories()` - Create XDG paths

### Prompt Templates
- **`src/prompts/organizer.ts`** (142 lines) - Worker prompts
  - **Purpose**: Format prompts for different worker types
  - **Key Functions**:
    - `formatOrganizerPrompt()` - Claude Code decomposition prompt (line 13)
    - `formatGeminiPrompt()` - Gemini feedback/critique/web prompts (line 86)

## File Structure
```
asyncthink/
├── CLAUDE.md              # This file - developer context
├── .env.example           # API key template
├── package.json           # Dependencies, scripts
├── tsconfig.json          # TypeScript config
├── vitest.config.ts       # Test config
├── src/
│   ├── index.ts           # ★ MCP SERVER ENTRY POINT
│   ├── lib/
│   │   ├── thinking.ts    # Sequential thinking + ThoughtInput type (110 LOC)
│   │   ├── orchestrator.ts # Worker spawning/management (414 LOC)
│   │   ├── gemini-client.ts # Gemini API client (236 LOC)
│   │   ├── ledger.ts      # Task state persistence (489 LOC)
│   │   └── config.ts      # XDG configuration (333 LOC)
│   └── prompts/
│       └── organizer.ts   # Worker prompt templates (142 LOC)
├── __tests__/
│   └── lib.test.ts        # Unit tests
└── dist/                  # Compiled output
```

## Component Interdependency Map

### Dependency Hierarchy (Most Critical → Least)
```
Level 1: src/index.ts (entry point)
    └──► All Level 2 components

Level 2: Business Logic
    ├── thinking.ts ──► (self-contained, exports ThoughtInput)
    ├── orchestrator.ts ──► ledger.ts, config.ts, gemini-client.ts, prompts/
    └── gemini-client.ts ──► config.ts

Level 3: Data Layer
    ├── ledger.ts ──► config.ts
    └── config.ts ──► (no internal deps)

Level 4: Utilities
    └── prompts/organizer.ts ──► (no deps)
```

### Impact Radius Documentation

| Component | Changes Affect | Update Requirements |
|-----------|---------------|---------------------|
| `index.ts` | Tool behavior, MCP protocol | Test with MCP inspector |
| `orchestrator.ts` | Worker spawning, result collection | Update ledger expectations |
| `gemini-client.ts` | Gemini worker behavior | Check API compatibility |
| `ledger.ts` | All task state | Migration if schema changes |
| `config.ts` | All components reading config | Update defaults carefully |
| `thinking.ts` | ThoughtInput type, thought processing | Update tests if interface changes |
| `prompts/organizer.ts` | Worker output format | Update result parsing |

## Architectural Thinking Protocol

**Before changing ANY component**:
1. Map affected components (direct + indirect dependencies)
2. Analyze downstream effects: "What breaks if this changes?"
3. Update interdependency maps in this document
4. Document impact radius: "Changes to X affect Y, Z"
5. Verify all related documentation is synchronized

**Red Flags**: Circular deps, undocumented workarounds, missing dependency updates

## Critical Debugging Points

### Key Log Identifiers
All logs go to stderr (stdout reserved for MCP protocol):

| Log Prefix | Component | What It Tracks |
|------------|-----------|----------------|
| `[AsyncThink]` | index.ts | Session ID, fork operations, cleanup |
| `[Orchestrator]` | orchestrator.ts | Worker spawning, completion, timeouts |
| `[GeminiClient]` | gemini-client.ts | API init, requests, response stats |
| `[Ledger]` | ledger.ts | Task lifecycle, cleanup, errors |
| `[Config]` | config.ts | Load/save operations |

### Common Issues & Solutions

**Issue**: Gemini workers fail with "API key not found"
**Diagnosis**: Check `GeminiClient.isAvailable()` returns false
**Fix**: Set `GOOGLE_API_KEY` or `GEMINI_API_KEY` environment variable

**Issue**: Gemini grounded search returns empty results
**Diagnosis**: `tools` array at wrong level in API request
**Fix**: Per @google/genai SDK, `tools` must be inside `config` object: `config.tools = [{ googleSearch: {} }]`

**Issue**: Claude Code workers timeout
**Diagnosis**: Check `[Orchestrator] Worker X timed out` in logs
**Fix**: Increase `workerTimeoutMs` via config tool or env var

**Issue**: Tasks from old sessions pollute results
**Diagnosis**: SESSION_ID scoping not filtering properly
**Fix**: Check `isCurrentSession()` function, ensure ledger cleanup runs

**Issue**: Research results not injected on final thought
**Diagnosis**: `nextThoughtNeeded: false` not triggering auto-wait
**Fix**: Verify lines 305-312 in index.ts (auto-wait logic)

## Development Environment

### Local Development Setup
```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run tests
npm test

# Watch mode during development
npm run watch
```

### Dependencies
- **Runtime**: Node.js 18+
- **@modelcontextprotocol/sdk**: ^1.24.0 - MCP protocol
- **@google/genai**: ^1.x - Gemini API client
- **zod**: ^3.x - Schema validation
- **chalk**: ^5.3.0 - Console formatting

### Environment Variables
```bash
# Required for Gemini workers
GOOGLE_API_KEY=your-key     # or GEMINI_API_KEY

# Optional overrides
ASYNCTHINK_DEFAULT_WORKERS=3     # 1-3
ASYNCTHINK_TIMEOUT_MS=120000     # Claude worker timeout
ASYNCTHINK_LOG_LEVEL=info        # debug|info|warn|error
DISABLE_THOUGHT_LOGGING=false    # Suppress formatted thoughts
```

### Testing & Validation
```bash
# Run all tests
npm test

# Run with coverage
npm test -- --coverage

# Smoke test MCP server
node dist/index.js  # Check stderr for startup messages
```

### XDG Data Paths
```
~/.local/share/asyncthink/
├── config.json    # Persisted configuration
├── ledger.json    # Task state
└── tasks/         # Worker output directories
    └── {SESSION_ID}::{taskId}/
        ├── stdout  # Worker output
        └── stderr  # Worker errors
```

## Developer Quick Start & Context Rebuilding

### Essential Files for Understanding
1. This file (CLAUDE.md) - Complete system context
2. `src/index.ts` - Main tool registration and handler
3. `src/lib/orchestrator.ts` - Worker lifecycle

### Most Common Developer Tasks

**Add new Gemini worker type**:
1. Add type to `formatGeminiPrompt()` in `prompts/organizer.ts`
2. Update `workerType` enum in `index.ts` schema (line 215)
3. Test with Gemini API

**Modify task persistence**:
1. Update `TaskState` interface in `ledger.ts`
2. Consider migration for existing ledger.json files
3. Update `getResult()` parsing if result format changes

**Change worker spawning behavior**:
1. Modify `spawnOrganizerWorker()` or `executeGeminiWorker()` in `orchestrator.ts`
2. Update timeout handling if needed
3. Test with both worker types

### Implementation Status
- **Complete**:
  - Sequential thinking core
  - Claude Code subprocess workers
  - Gemini fast workers (feedback, critique, web)
  - Session isolation
  - Auto-wait/auto-inject on final thought
  - Configuration tool
  - XDG persistence

- **Future Considerations**:
  - Worker result caching
  - Parallel multi-worker optimization
  - Custom Gemini model selection per-call
