import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { ToolContext } from "./index.js";
import { isMcpDenied, isMcpAllowed } from "./permissions.js";

export async function connectMcpServers(config: import("../config.js").Config): Promise<{ rawTools: StructuredToolInterface[]; close: () => Promise<void> } | undefined> {
  const entries = Object.entries(config.mcp.servers ?? {});
  if (entries.length === 0) return undefined;

  const mcpServers: Record<string, unknown> = {};
  for (const [name, def] of entries) {
    const d = def as import("../config.js").McpServerConfig;
    const cfg: Record<string, unknown> = {};
    if (d.url) {
      cfg.url = d.url;
      if (d.headers) cfg.headers = d.headers;
      if (d.insecureTls) cfg.requestTls = { rejectUnauthorized: false } as unknown;
    }
    mcpServers[name] = cfg;
  }

  const { MultiServerMCPClient } = await import("@langchain/mcp-adapters");
  const client = new MultiServerMCPClient({
    mcpServers,
    prefixToolNameWithServerName: true,
    additionalToolNamePrefix: "",
    throwOnLoadError: true,
    useStandardContentBlocks: true,
    onConnectionError: "ignore",
  } as unknown as ConstructorParameters<typeof MultiServerMCPClient>[0]);

  // dyn import types: call getTools via any to avoid tight typing on runtime lib
  const tools = await (client as unknown as { getTools: () => Promise<StructuredToolInterface[]> }).getTools();
  const filtered = tools.filter((t: StructuredToolInterface) => {
    const parts = t.name.split("__");
    if (parts.length < 2) return true;
    const serverName = parts[0];
    const toolName = parts.slice(1).join("__");
    const servers = config.mcp.servers as Record<string, import("../config.js").McpServerConfig> | undefined;
    const serverCfg = serverName !== undefined ? servers?.[serverName] : undefined;
    if (!serverCfg) return true;
    if (!Array.isArray(serverCfg.tools)) return true;
    return serverCfg.tools.includes(toolName);
  });

  return {
    rawTools: filtered,
    close: async () => {
      await client.close();
    },
  };
}

export function createGatedMcpTools(ctx: ToolContext, rawTools: StructuredToolInterface[]): StructuredToolInterface[] {
  return rawTools.map((rt) => {
    const name = rt.name;
    return tool(async (args: unknown) => {
      // Denylist check first
      if (isMcpDenied(ctx.config.permissions, name)) {
        return `[blocked] MCP tool ${name} matches the mcp denylist`;
      }
      const preapproved = isMcpAllowed(ctx.config.permissions, name);
      const req: import("./index.js").ApprovalRequest = { action: "mcp", title: `MCP tool ${name}`, preview: JSON.stringify(args), preapproved, subject: name };
      // gate() from index.ts
      const { gate } = await import("./index.js");
      const exec = async () => {
        try {
          const out = await rt.invoke(args as never);
          if (typeof out === "string") return out;
          return JSON.stringify(out);
        } catch (e) {
          return `[error] ${(e as Error).message ?? String(e)}`;
        }
      };
      return gate(ctx, req, exec);
    }, {
      name: rt.name,
      description: rt.description,
      schema: (rt as { schema?: unknown }).schema as never,
    });
  });
}
