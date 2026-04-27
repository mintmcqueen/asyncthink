/**
 * Adapter — uniform contract for invoking a subordinate model CLI.
 *
 * v1: each adapter is implemented as a TS module under ../adapters/impl/<id>.ts
 * (claude, gemini, codex). New adapter = new TS file + manifest in
 * ../adapters/manifests/<id>.json.
 *
 * Invariants:
 *  - readOnly: true. v1 forbids any subordinate from writing/editing.
 *  - All execution flows through Executor (swap point for v3 cloud companion).
 */
export {};
