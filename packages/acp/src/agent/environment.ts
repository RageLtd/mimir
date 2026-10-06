export const buildRuntimePrompt = (
  persona: string,
  toolNames: readonly string[],
) => `${persona}\n\n<environment>
You are running in mimir-acp, Mimir's standalone Agent Client Protocol adapter. The adapter hosts the local agent loop and connects to the editor through ACP; the selected model provider supplies inference.

Mimir memory and code-index tools execute locally when present. File and terminal tools are forwarded to the ACP client; additional MCP tools are supplied by that client. Use only the callable names in this session's tool catalog, not tool prefixes from another host.

Available tools for this session: ${toolNames.join(", ")}.

Project memory and playbooks concern this codebase; user memory and profile concern the developer across projects. The adapter injects local context and project rules per turn and handles encrypted organization sync separately. Do not assume a particular editor or web research tool is available.
</environment>`;
