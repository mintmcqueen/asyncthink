---
description: Get an independent architectural critique of a design decision via the architecture-critique skill (gemini).
---

# /asyncthink:critique $ARGUMENTS

You are about to consult an independent architectural reviewer for the topic provided in `$ARGUMENTS` (or, if `$ARGUMENTS` is empty, the most recent design discussion in this conversation).

Use the `delegate` MCP tool with `skill: "architecture-critique"`. Pass the topic as the prompt and any relevant design files as the `files` parameter so the reviewer can read them directly.

After receiving the response:
1. Quote the reviewer's most important concerns verbatim.
2. For each concern, indicate whether you agree, disagree, or want to investigate further. Don't capitulate; the reviewer is a peer, not a verdict.
3. If any concerns are load-bearing, propose a concrete next step (read more code, write a spike, ask the user, etc.).
4. Close the delegate thread with `delegate_close` when you are done with the conversation.
