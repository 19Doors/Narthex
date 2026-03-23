// tools/sandbox.ts
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);

// ─── Main thread only ─────────────────────────────────────────────────────────
export async function runInSandbox(
  code: string,
  agentContext: unknown,
): Promise<string> {
  // Import here, not at module top — worker never reaches this function
  const { allApps } = await import("./core");
  const allTools = allApps.flatMap((app) => app.tools);
  const toolNames = allTools.map((t) => t.name);

  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, {
      workerData: { code, toolNames, isWorker: true },
    });

    worker.on("message", async (msg) => {
      if (msg.type === "tool_call") {
        try {
          const tool = allTools.find((t) => t.name === msg.toolName);
          if (!tool) throw new Error(`Tool '${msg.toolName}' not found`);

          const validated = tool.schema.parse(msg.params);
          const result = await tool.execute(validated, agentContext);

          worker.postMessage({
            type: "tool_result",
            callId: msg.callId,
            result: result.content[0].text,
          });
        } catch (err: any) {
          worker.postMessage({
            type: "tool_result",
            callId: msg.callId,
            error: err.message,
          });
        }
      }

      if (msg.type === "done") {
        resolve(msg.result);
        worker.terminate();
      }

      if (msg.type === "error") {
        reject(new Error(msg.error));
        worker.terminate();
      }
    });

    worker.on("error", reject);

    setTimeout(() => {
      worker.terminate();
      reject(new Error("Sandbox timeout: exceeded 10s"));
    }, 10_000);
  });
}

// ─── Worker thread only ───────────────────────────────────────────────────────
if (!isMainThread && workerData?.isWorker) {
  const { code, toolNames } = workerData as {
    code: string;
    toolNames: string[];
  };

  const pending = new Map<string, { resolve: Function; reject: Function }>();

  parentPort!.on("message", (msg) => {
    if (msg.type === "tool_result") {
      const p = pending.get(msg.callId);
      if (!p) return;
      pending.delete(msg.callId);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    }
  });

  function makeTool(toolName: string) {
    return (params: unknown): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const callId = `${toolName}_${Date.now()}_${Math.random()}`;
        pending.set(callId, { resolve, reject });
        parentPort!.postMessage({
          type: "tool_call",
          toolName,
          params,
          callId,
        });
      }).then((raw) => {
        try {
          return JSON.parse(raw as string);
        } catch {
          return raw;
        }
      });
  }

  async function run() {
    // Build tool stubs only from names passed via workerData — no imports needed
    const toolStubs = Object.fromEntries(
      toolNames.map((name) => [name, makeTool(name)]),
    );

    try {
      const fn = new Function(
        ...toolNames, // named args
        `return (async () => { ${code} })()`,
      );

      const result = await fn(...toolNames.map((n) => toolStubs[n]));
      parentPort!.postMessage({
        type: "done",
        result: JSON.stringify(result ?? null),
      });
    } catch (err: any) {
      parentPort!.postMessage({ type: "error", error: err.message });
    }
  }

  run();
}
