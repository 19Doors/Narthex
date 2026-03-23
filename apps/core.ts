import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { githubApp } from "./github";
import { gmailApp } from "./gmail";
import { notionApp } from "./notion";
import { runInSandbox } from "./sandbox";

export const allApps = [githubApp, gmailApp, notionApp];
const allTools = allApps.flatMap((app) => app.tools);

export const coreApp = {
  appId: "nathrax_core",
  displayName: "Nathrax Core Services",
  tools: [
    {
      name: "nathrax_search_tools",
      description:
        "Search the Nathrax gateway for available integration tools. Always use this to discover capabilities before trying to execute actions.",
      schema: z.object({
        query: z
          .string()
          .describe(
            "Search keywords (e.g., 'gmail', 'github issues', 'notion pages'). Include the application name.",
          ),
      }),
      execute: async ({ query }: { query: string }) => {
        const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);

        const matches = allTools
          .map((t) => {
            const haystack = `${t.name} ${t.description}`.toLowerCase();
            const matchCount = tokens.filter((tok) =>
              haystack.includes(tok),
            ).length;
            return { tool: t, matchCount };
          })
          .filter(({ matchCount }) => matchCount > 0)
          .sort((a, b) => b.matchCount - a.matchCount)
          .map(({ tool: t }) => ({
            name: t.name,
            description: t.description,
            schema: zodToJsonSchema(t.schema),
          }));

        return {
          content: [{ type: "text", text: JSON.stringify(matches, null, 2) }],
        };
      },
    },
    // {
    //   name: "nathrax_execute_tool",
    //   description:
    //     "Execute a specific tool discovered via nathrax_search_tools.",
    //   schema: z.object({
    //     tool_name: z.string().describe("The exact name of the tool to execute"),
    //     parameters: z
    //       .record(z.string(), z.unknown())
    //       .describe("Parameters matching the tool's discovered schema"),
    //   }),
    //   execute: async (
    //     {
    //       tool_name,
    //       parameters,
    //     }: { tool_name: string; parameters: Record<string, unknown> },
    //     context: unknown,
    //   ) => {
    //     const tool = allTools.find((t) => t.name === tool_name);
    //
    //     if (!tool) {
    //       return {
    //         content: [
    //           {
    //             type: "text",
    //             text: `Tool '${tool_name}' not found. Use nathrax_search_tools first.`,
    //           },
    //         ],
    //         isError: true,
    //       };
    //     }
    //
    //     try {
    //       const validated = tool.schema.parse(parameters);
    //       return await tool.execute(validated, context);
    //     } catch (error: any) {
    //       return {
    //         content: [
    //           {
    //             type: "text",
    //             text: `Execution Error: ${error.message}`,
    //           },
    //         ],
    //         isError: true,
    //       };
    //     }
    //   },
    // },
    {
      name: "nathrax_run_code",
      description: `
    Write JavaScript code to orchestrate multiple tool calls efficiently.
    All tools are available as async functions by their exact name.
    Use Promise.all for parallel calls.
    The code must return a value — only that final value enters your context.
    Example: 
      const [a, b] = await Promise.all([tool_one({...}), tool_two({...})]);
      return { a, b };
  `,
      schema: z.object({
        code: z.string().describe("JavaScript code. Must return a value."),
      }),
      execute: async ({ code }: { code: string }, context: unknown) => {
        try {
          const result = await runInSandbox(code, context);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Sandbox Error: ${err.message}` }],
            isError: true,
          };
        }
      },
    },
  ],
};
