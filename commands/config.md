---
description: View or change AsyncThink configuration in natural language — settings (default adapter, default subagent) and subagents (personas the claude adapter uses on subscription auth). Wraps the asyncthink_config MCP tool.
---

# /asyncthink:config $ARGUMENTS

You are the orchestrator. The user wants to view or modify AsyncThink's configuration — settings and/or subagents. Their request is in `$ARGUMENTS` (free-form natural language). If `$ARGUMENTS` is empty, default to showing the current settings + subagent list.

Translate the user's intent into one or more calls to the `asyncthink_config` MCP tool. Never invent fields — only use the actions and arg shapes documented below.

## Reference — `asyncthink_config` actions

### Settings layer (`~/.config/asyncthink/settings.toml` + `.claude/asyncthink.local.md`)

| Action | Args | Returns |
| --- | --- | --- |
| `get_settings` | (none) | `{effective: {defaults: {adapter, subagent}}, layers: [{source, path, exists, values}]}` |
| `set_setting` | `{key, value, scope?}` | Updated `{effective, layers}` |
| `unset_setting` | `{key, scope?}` | Updated `{effective, layers}` |

- **Whitelisted keys**: `defaults.adapter` (`claude` \| `gemini` \| `codex`), `defaults.subagent` (id of a Subagent in the registry).
- **`scope`**: `"user"` (default — writes `~/.config/asyncthink/settings.toml`) or `"project"` (writes `.claude/asyncthink.local.md` in cwd; ancestor-walked at read time).
- **Resolution precedence** (highest first): per-call arg > skill frontmatter > project settings > user settings > built-in default (`adapter: "claude"`, `subagent: "asyncthink-delegate"`).

### Subagent registry (`~/.local/share/asyncthink/subagents/<id>.json`)

| Action | Args | Returns |
| --- | --- | --- |
| `subagent_list` | (none) | `{subagents: [Subagent, ...]}` |
| `subagent_get` | `{subagentId}` | `Subagent` or `{error: "subagent_not_found"}` |
| `subagent_create` | `{subagent: {name, description, prompt, tools?, model?}}` | Created `Subagent` (id derived from `slugifyName(name)`) |
| `subagent_update` | `{subagentId, subagent: <patch>}` | Updated `Subagent` |
| `subagent_delete` | `{subagentId}` | `{deleted: true \| false}` |

- A `Subagent` is a persistent persona the claude adapter spawns with via `--agents '<inline-json>' --agent <id>` on the subscription auth path (no `ANTHROPIC_API_KEY` in env).
- Built-in: `asyncthink-delegate` (read-only navigation: `[Read, Grep, Glob]`).
- `tools` is the allowlist passed to claude; omit to inherit Claude Code defaults.

## Translation rubric

Match the user's intent to one of these intents:

1. **View state** ("show me my config", "what's set?", "list subagents", empty `$ARGUMENTS`)
   → call `get_settings` AND `subagent_list`. Render both compactly. For settings, show the EFFECTIVE values + a one-line per-layer breakdown so the user sees which layer set each value. For subagents, show id + name + isBuiltIn (yes/no) + tools count.

2. **Switch default adapter** ("use gemini", "default to claude", "switch to codex")
   → `set_setting({key: "defaults.adapter", value: "<adapter>", scope: "user"})` unless the user explicitly says "for this project" / "for this repo" — then `scope: "project"`. After the call, re-render the new effective adapter so the user sees the change took.

3. **Switch default subagent** ("use the security-review subagent", "default subagent to X")
   → `set_setting({key: "defaults.subagent", value: "<id>", scope: ...})`. If the user names a subagent that doesn't exist, first `subagent_list` to surface available ids and ask before creating one.

4. **Clear a setting** ("unset default adapter", "remove project setting for subagent", "revert to default")
   → `unset_setting({key, scope})`. Default `scope: "user"` unless project is implied.

5. **Create a subagent** ("make a new subagent called code-reviewer that …", "create a security-review persona")
   → `subagent_create({subagent: {name, description, prompt, tools?, model?}})`.
   - You may need to ask follow-up questions if the user supplied only a name. Required: `name`, `description` (one-line), `prompt` (the persona system prompt — multi-paragraph is fine).
   - `tools` default to AsyncThink's read-only set if the user doesn't specify and the subagent is intended as a delegate persona: `["Read", "Grep", "Glob"]`. For broader subagents, ask the user.
   - After creating, suggest binding it as the default: `Want me to set this as the active subagent? I'll run set_setting({key:"defaults.subagent", value:"<id>"}).`

6. **Update a subagent** ("change the prompt on asyncthink-delegate to …", "give code-reviewer access to WebSearch")
   → `subagent_update({subagentId, subagent: <patch>})`. Read the current state first via `subagent_get` if helpful to confirm the diff.

7. **Delete a subagent** ("remove the code-reviewer subagent")
   → If the subagent is `isBuiltIn: true`, warn the user that it'll be rebootstrapped on next server restart. Then `subagent_delete({subagentId})`.

8. **Ambiguous** — if you can't confidently route the request, ask one clarifying question. Don't guess and write.

## Output formatting

After each call:
- Quote any errors verbatim (don't paraphrase `error: "credentials_not_supported"` etc.).
- For mutation actions, confirm what changed in one sentence: `"Default adapter is now gemini (user scope)."`
- For view actions, render compact tables/lists, not JSON dumps.
- If the call surfaced a layered settings result, show the EFFECTIVE values clearly first, then a one-line `(from <source>)` annotation per key.

## Things NOT to do

- Don't invent setting keys outside the whitelist (`defaults.adapter`, `defaults.subagent`). The tool will reject unknown keys; don't try.
- Don't write multi-paragraph subagent prompts on the user's behalf without confirming the persona intent first.
- Don't delete a user-created subagent without confirming. (Built-ins can be re-bootstrapped, so deletion is reversible there; user customizations are not.)
- Don't change `scope` silently — if the user didn't say "project", default to `user` and note the scope in your confirmation.
