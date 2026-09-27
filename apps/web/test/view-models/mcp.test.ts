import { formatToolName, type McpServerSummary, type McpStatus } from "@analytax/contracts";
import { describe, expect, it } from "vitest";
import { summarizeSettings } from "../../src/features/home/RunSettings";
import { currentActivity } from "../../src/view-models/dispatch";
import { describeRunToolServers, groupAgentTools, serverSwitches, toRunMcpOptions } from "../../src/view-models/mcp";

const server = (overrides: Partial<McpServerSummary> & { id: string }): McpServerSummary => ({
  title: overrides.id,
  description: null,
  host: `${overrides.id}.example.com`,
  transport: "auto",
  activeTransport: null,
  enabled: true,
  status: "idle",
  detail: null,
  lastError: null,
  lastConnectedAt: null,
  nextRetryAt: null,
  tools: [],
  skippedTools: [],
  guardWarnings: [],
  usedBy: [],
  ...overrides,
});

describe("MCP tool names", () => {
  it("read as server: tool and leave built-in names alone", () => {
    expect(formatToolName("mcp__deepwiki__ask_wiki_question")).toBe("deepwiki: ask_wiki_question");
    expect(formatToolName("web_search")).toBe("web_search");
  });

  it("show readably in the live Now line", () => {
    const activity = currentActivity({ status: "running", tools: [{ tool: "mcp__docs__search", ok: null, startedAt: "t" }], thoughts: [], modelCalls: 1, lastActivityAt: "t" } as never);
    expect(activity.text).toBe("Using docs: search");
  });
});

describe("agent tool groups", () => {
  it("lists built-ins, then MCP tools under their server title", () => {
    const groups = groupAgentTools(["web_search", "mcp:deepwiki/ask_wiki_question", "mcp:gh/*"], [server({ id: "deepwiki", title: "DeepWiki" })]);
    expect(groups).toEqual({
      builtin: ["web_search"],
      servers: [
        { id: "deepwiki", title: "DeepWiki", tools: ["ask_wiki_question"] },
        { id: "gh", title: "gh", tools: ["All tools"] },
      ],
    });
  });
});

describe("per-run tool server switches", () => {
  const status: McpStatus = {
    enabled: true,
    disabledReason: null,
    servers: [
      server({ id: "deepwiki", title: "DeepWiki", status: "connected", usedBy: [{ agentId: "researcher", refs: ["ask_wiki_question"], missing: [] }] }),
      server({ id: "github", enabled: false, status: "disabled", detail: "Turned off in config/mcp.yaml.", usedBy: [{ agentId: "analyst", refs: ["*"], missing: [] }] }),
      server({ id: "unused" }),
    ],
  };

  it("offers only servers agents use, and disables the unusable ones", () => {
    const switches = serverSwitches(status);
    expect(switches.map((entry) => [entry.id, entry.usable])).toEqual([
      ["deepwiki", true],
      ["github", false],
    ]);
    expect(switches[0]?.hint).toBe("Used by researcher.");
    expect(serverSwitches(status, (id) => (id === "researcher" ? "Research Specialist" : id))[0]?.hint).toBe("Used by Research Specialist.");
    expect(switches[1]?.hint).toBe("Turned off in config/mcp.yaml.");
    expect(serverSwitches({ ...status, enabled: false })).toEqual([]);
  });

  it("sends only known servers, and nothing when all are on", () => {
    const switches = serverSwitches(status);
    expect(toRunMcpOptions(["deepwiki", "gone"], switches)).toEqual({ disabled: ["deepwiki"] });
    expect(toRunMcpOptions([], switches)).toBeUndefined();
  });

  it("mentions switched-off servers in the settings summary", () => {
    const value = { hitl: { clarify: true, approvePlan: false, humanReview: false }, maxConcurrency: 4, faults: [], toolServersOff: ["deepwiki"] };
    expect(summarizeSettings(value)).toBe("Check-ins: questions, 4 in parallel, 1 tool server off");
  });

  it("describes a run's servers for the Usage tab", () => {
    expect(
      describeRunToolServers([
        { id: "deepwiki", title: "DeepWiki", status: "connected", toolCount: 3, tools: [], detail: null },
        { id: "github", title: "GitHub", status: "off", toolCount: 0, tools: [], detail: null },
      ]),
    ).toBe("DeepWiki: connected; GitHub: off for this run");
    expect(describeRunToolServers(null)).toBeNull();
  });
});

describe("tool output previews", () => {
  it("drop the framing meant for the model", async () => {
    const { unwrapToolOutput } = await import("@analytax/contracts");
    expect(unwrapToolOutput('<tool_output server="docs" tool="search" trust="untrusted">\nhello\n</tool_output>')).toBe("hello");
    expect(unwrapToolOutput('<tool_output server="docs" tool="search" trust="untrusted">\npartial preview')).toBe("partial preview");
    expect(unwrapToolOutput("Error from Docs: boom")).toBe("Error from Docs: boom");
  });
});
