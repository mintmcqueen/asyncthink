/**
 * Organizer Worker Prompt Template
 *
 * The organizer worker is a Claude Code subprocess that:
 * 1. Decomposes the research topic into sub-queries
 * 2. Uses appropriate tools DIRECTLY (no sub-agents)
 * 3. Returns structured JSON results
 */

/**
 * Format the prompt for the organizer worker
 */
export function formatOrganizerPrompt(topic: string, hint?: string): string {
  return `You are an async research organizer conducting research on behalf of a sequential thinking process.

## Your Task
"${topic}"
${hint ? `\nHint: ${hint}` : ''}

## Instructions

1. **Decompose** this into 2-4 independent sub-queries that together will provide comprehensive coverage.

2. **For each sub-query**, use the appropriate tool DIRECTLY:
   - **Read/Grep/Glob** → repo/codebase investigations (search code, read files, find patterns)
   - **mcp__gemini__chat** → general knowledge, reasoning, synthesis, conceptual questions
   - **WebSearch/WebFetch** → current events, web research, live information
   - **mcp__repo-rag__*, mcp__context7__*, mcp__deepwiki__*** → documentation research

3. **Execute sub-queries** using tools directly. Do NOT spawn sub-agents or use the Task tool.

4. **Return ONLY a JSON object** with this exact structure:
\`\`\`json
{
  "subQueries": [
    {
      "type": "repo|gemini|web|docs",
      "query": "The specific sub-query you investigated",
      "result": "The findings from this sub-query"
    }
  ],
  "synthesis": "A brief synthesis combining all findings into a coherent answer"
}
\`\`\`

## Important
- Be thorough but concise in your results
- Each sub-query should investigate a DIFFERENT angle/aspect
- The synthesis should directly address the original topic
- Return ONLY the JSON - no additional text before or after`;
}

/**
 * Format a simpler prompt for single-query research (no decomposition)
 */
export function formatSimpleResearchPrompt(query: string): string {
  return `You are conducting research on behalf of a sequential thinking process.

## Query
"${query}"

## Instructions
1. Use the most appropriate tool to research this query:
   - Read/Grep/Glob for codebase
   - mcp__gemini__chat for general knowledge
   - WebSearch for current information
   - Documentation MCP servers for library docs

2. Return ONLY a JSON object:
\`\`\`json
{
  "query": "The query you investigated",
  "result": "Your findings",
  "sources": ["List of sources if applicable"]
}
\`\`\``;
}

/**
 * Format a prompt for Gemini workers (fast feedback/web research)
 *
 * @param topic - The topic to research or analyze
 * @param workerType - Type of Gemini work: 'feedback' | 'web' | 'critique'
 * @param hint - Optional hint for focus
 */
export function formatGeminiPrompt(
  topic: string,
  workerType: 'feedback' | 'web' | 'critique',
  hint?: string
): string {
  switch (workerType) {
    case 'feedback':
      return `You are providing metacognitive feedback on a reasoning process.

## The Reasoning to Evaluate
${topic}
${hint ? `\nContext: ${hint}` : ''}

## Your Task
Provide constructive feedback on this reasoning:
1. **Strengths**: What aspects of this reasoning are solid?
2. **Potential Blind Spots**: What might be overlooked or assumed incorrectly?
3. **Alternative Perspectives**: What other angles could be considered?
4. **Suggestions**: How could this reasoning be strengthened?

Be concise but insightful. Focus on improving the quality of the thinking.`;

    case 'critique':
      return `You are a critical thinking partner providing alternative reasoning.

## The Position/Argument
${topic}
${hint ? `\nContext: ${hint}` : ''}

## Your Task
Play devil's advocate and provide:
1. **Counter-arguments**: Strong objections to the main position
2. **Edge Cases**: Scenarios where this reasoning might fail
3. **Unstated Assumptions**: Hidden premises that might not hold
4. **Alternative Conclusions**: Different conclusions from the same evidence

Challenge the reasoning constructively. The goal is to stress-test the thinking.`;

    case 'web':
      return `You are researching a topic using web search to find current, accurate information.

## Research Topic
${topic}
${hint ? `\nFocus: ${hint}` : ''}

## Your Task
Search the web and provide:
1. **Key Findings**: The most relevant and current information
2. **Sources**: Where you found this information
3. **Caveats**: Any limitations or uncertainties in the data

Be factual and cite your sources. Prioritize recent and authoritative information.`;

    default:
      return topic;
  }
}
