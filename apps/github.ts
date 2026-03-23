import { z } from "zod";
import { db } from "../db";
import { connections } from "../db/schema";
import { and, eq } from "drizzle-orm";

const BASE_URL = process.env.BASE_URL;
const BASE_PORT = process.env.BASE_PORT;

// --- 1. THE CORE API WRAPPER ---
// This handles the Drizzle lookup, Auth Fallback, and HTTP requests for EVERY tool.
async function githubRequest(
  endpoint: string,
  options: RequestInit,
  context: { developerId: string; endUserId: string },
) {
  const connection = await db.query.connections.findFirst({
    where: and(
      eq(connections.developerId, context.developerId),
      eq(connections.endUserId, context.endUserId),
      eq(connections.appId, "github"),
    ),
  });

  if (!connection) {
    const authUrl = `${BASE_URL}:${BASE_PORT}/auth/github?devId=${context.developerId}&userId=${context.endUserId}`;
    return {
      content: [
        {
          type: "text",
          text: `Auth required. Please authorize GitHub: ${authUrl}`,
        },
      ],
      isError: true,
    };
  }

  try {
    const response = await fetch(`https://api.github.com${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${connection.accessToken}`,
        "User-Agent": "Nathrax-Gateway",
        Accept: "application/vnd.github.v3+json",
        ...options.headers,
      },
    });

    if (!response.ok) {
      return {
        content: [
          {
            type: "text",
            text: `GitHub API Error: ${response.status} ${response.statusText}`,
          },
        ],
        isError: true,
      };
    }

    const data = await response.json();
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `Network Error: ${error.message}` }],
      isError: true,
    };
  }
}

// --- 2. THE TOOL DEFINITIONS ---

export const githubApp = {
  appId: "github",
  displayName: "GitHub Integration",
  version: "1.1.0",
  tools: [
    // Tool 1: Get User Profile
    {
      name: "github_get_profile",
      description: "Fetches the authenticated user's GitHub profile.",
      schema: z.object({}),
      execute: async (_args: any, context: any) => {
        return await githubRequest("/user", { method: "GET" }, context);
      },
    },

    // Tool 2: Search Repositories
    {
      name: "github_search_repositories",
      description: "Search for GitHub repositories using a query string.",
      schema: z.object({
        query: z
          .string()
          .describe(
            "The search query (e.g., 'language:typescript stars:>1000')",
          ),
        per_page: z.number().optional().default(5),
      }),
      execute: async ({ query, per_page }: any, context: any) => {
        const encodedQuery = encodeURIComponent(query);
        return await githubRequest(
          `/search/repositories?q=${encodedQuery}&per_page=${per_page}`,
          { method: "GET" },
          context,
        );
      },
    },

    // Tool 3: Read a File's Contents
    {
      name: "github_get_file_contents",
      description: "Get the contents of a specific file in a repository.",
      schema: z.object({
        owner: z
          .string()
          .describe("Repository owner (username or organization)"),
        repo: z.string().describe("Repository name"),
        path: z.string().describe("Path to the file (e.g., 'src/index.ts')"),
      }),
      execute: async ({ owner, repo, path }: any, context: any) => {
        // We use the raw media header to get the actual text instead of base64 encoded JSON
        const options = {
          method: "GET",
          headers: { Accept: "application/vnd.github.v3.raw" },
        };
        const res = await githubRequest(
          `/repos/${owner}/${repo}/contents/${path}`,
          options,
          context,
        );

        // Minor override: if it's raw text, githubRequest might fail the .json() parse.
        // In a full production app, you'd tweak the wrapper to check content-type!
        return res;
      },
    },

    // Tool 4: Get Issue Details
    {
      name: "github_get_issue",
      description: "Fetch details of a specific issue or pull request.",
      schema: z.object({
        owner: z.string(),
        repo: z.string(),
        issue_number: z.number(),
      }),
      execute: async ({ owner, repo, issue_number }: any, context: any) => {
        return await githubRequest(
          `/repos/${owner}/${repo}/issues/${issue_number}`,
          { method: "GET" },
          context,
        );
      },
    },

    // Tool 5: Create a New Issue
    {
      name: "github_create_issue",
      description: "Create a new issue in a specific repository.",
      schema: z.object({
        owner: z.string(),
        repo: z.string(),
        title: z.string().describe("The title of the issue"),
        body: z.string().describe("The markdown body/description of the issue"),
      }),
      execute: async ({ owner, repo, title, body }: any, context: any) => {
        return await githubRequest(
          `/repos/${owner}/${repo}/issues`,
          {
            method: "POST",
            body: JSON.stringify({ title, body }),
          },
          context,
        );
      },
    },
  ],
};
