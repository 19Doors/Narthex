import { Hono } from "hono";
import { cors } from "hono/cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { db } from "./db";
import { developers } from "./db/schema";
import { eq } from "drizzle-orm";
import { AsyncLocalStorage } from "node:async_hooks"; // 1. IMPORT THIS

import { auth } from "./routes/auth";
import { coreApp } from "./apps/core";

// 2. CREATE THE CONTEXT STORE
// This will securely hold our IDs for the duration of a single request
export const mcpContext = new AsyncLocalStorage<{
  developerId: string;
  endUserId: string;
}>();

const app = new Hono();

app.use("/*", cors());
app.route("/auth", auth);

// 3. UPDATED AUTH MIDDLEWARE
app.use("/mcp/*", async (c, next) => {
  const authHeader = c.req.header("Authorization");
  // Clients must pass the end-user's ID in this header
  const endUserId = c.req.header("x-user-id");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json(
      { error: "Unauthorized. Please provide a Bearer token." },
      401,
    );
  }

  if (!endUserId) {
    return c.json({ error: "Bad Request. Missing x-user-id header." }, 400);
  }

  const apiKey = authHeader.split(" ")[1];
  const rows = await db
    .select()
    .from(developers)
    .where(eq(developers.apiKey, apiKey));

  if (rows.length === 0) {
    console.warn(`[AUTH] Rejected: Invalid API Key used (${apiKey})`);
    return c.json({ error: "Forbidden. Invalid API Key." }, 403);
  }

  const developerId = rows[0]?.id;
  console.log(`[AUTH] Success! Dev: ${developerId} | User: ${endUserId}`);

  // 4. WRAP THE REQUEST IN THE CONTEXT STORE
  // Everything executed inside this block (including MCP tools) can access these IDs
  await mcpContext.run({ developerId, endUserId }, async () => {
    await next();
  });
});

// --- MCP Server Setup ---

const mcpServer = new McpServer({
  name: "nathrax-gateway",
  version: "0.1.0",
});

const activeApps = [coreApp];

activeApps.forEach((app) => {
  console.log(`[REGISTRY] Loading App: ${app.displayName}`);

  app.tools.forEach((tool) => {
    mcpServer.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.schema,
      },
      async (args: any) => {
        // 5. EXTRACT THE REAL CONTEXT DYNAMICALLY!
        // No more mock data. We pull the exact IDs for whoever triggered this tool.
        const context = mcpContext.getStore();

        if (!context) {
          throw new Error("Tool executed outside of secure MCP context");
        }

        return await tool.execute(args, context);
      },
    );
    console.log(`  -> Registered Tool: ${tool.name}`);
  });
});

mcpServer.registerTool("ping", {}, async () => {
  return { content: [{ type: "text", text: "Nathrax Gateway is alive!" }] };
});

const transport = new StreamableHTTPTransport();

app.all("/mcp", async (c) => {
  if (!mcpServer.isConnected()) {
    await mcpServer.connect(transport);
  }
  return transport.handleRequest(c);
});

// 6. BUN NATIVE EXPORT
// We don't need @hono/node-server anymore!
const port = 3003;
console.log(`🛡️ Nathrax Gateway running on http://localhost:${port}/mcp`);

export default {
  port,
  fetch: app.fetch,
  idleTimeout: 255,
};
