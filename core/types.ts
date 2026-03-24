// nathrax.types.ts
import { z } from "zod";

export interface NathraxTool<T extends z.ZodRawShape> {
  name: string;
  description: string;
  schema: T;
  execute: (
    args: z.infer<z.ZodObject<T>>,
    context: { developerId: string; endUserId: string },
  ) => Promise<any>;
}

export interface NathraxApp {
  appId: string;
  displayName: string;
  version: string;
  tools: NathraxTool<any>[];
}
