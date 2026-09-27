/**
 * Origins of configured MCP servers. HTTP client spans for them are suppressed: `url.full` could carry values
 * interpolated from the environment, and tool calls already have their own `execute_tool` spans.
 */
const origins = new Set<string>();

export const registerMcpOrigin = (url: URL): void => {
  origins.add(url.origin);
};

export const isMcpOrigin = (origin: string): boolean => origins.has(origin);
