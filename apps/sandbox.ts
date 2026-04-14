import type { NathraxTool } from "../core/types";

// apps/sandbox.ts
export async function runInSandbox(
  code: string,
  tools: NathraxTool<any>[],
  context: { developerId: string; endUserId: string },
): Promise<string> {
  // Build callable wrappers for every tool
  const toolFunctions: Record<string, (params: any) => Promise<any>> = {};

  for (const tool of tools) {
    toolFunctions[tool.name] = async (params: any) => {
      const validated = tool.schema.parse(params);
      const result = await tool.execute(validated, context);

      // Auto-parse JSON responses so scripts get real objects, not strings
      const text = result?.content?.[0]?.text;
      if (text) {
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      }
      return result;
    };
  }

  const toolNames = Object.keys(toolFunctions);
  const toolValues = toolNames.map((n) => toolFunctions[n]);

  // Inject tools as named parameters — no global pollution
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction(...toolNames, `"use strict";\n${code}`);

  const timeoutGuard = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error("Sandbox timeout: 30s exceeded")),
      30_000,
    ),
  );

  const result = await Promise.race([fn(...toolValues), timeoutGuard]);

  // Return compressed output — not a bloated full JSON dump
  if (result === null || result === undefined) return "Done. No return value.";
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}
