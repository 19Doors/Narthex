import { z } from "zod";

// This defines a single action an LLM can take (e.g., "Create Notion Page")
export interface NathraxTool<T extends z.ZodRawShape> {
  name: string;
  description: string;
  schema: T;
  // The execute function contains the actual API logic
  // We pass in a `context` object so the tool knows WHICH developer triggered it
  execute: (
    args: z.infer<z.ZodObject<T>>,
    context: { developerId: string; endUserId: string },
  ) => Promise<any>;
}

// This defines an entire App (e.g., "Notion" or "GitHub")
export interface NathraxApp {
  appId: string; // e.g., "github"
  displayName: string; // e.g., "GitHub Integration"
  version: string;
  tools: NathraxTool<any>[];
}
