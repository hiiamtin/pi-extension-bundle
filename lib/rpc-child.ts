// Minimal JSONL rpc client for `pi --mode rpc` children (docs/rpc.md).
//
// Framing rule from the protocol docs: records are delimited by LF ONLY —
// generic line readers (node:readline) are not protocol-compliant because
// they also split on U+2028/U+2029, which are valid inside JSON strings.
// Every request is correlated by a generated `id`; agent events are handed
// to registered handlers in arrival order.

import { spawn, type ChildProcess } from "node:child_process";

export interface RpcExit {
  code: number | null;
  signal: string | null;
}

export interface RpcChild {
  readonly pid: number;
  readonly exited: boolean;
  /** Send a command and resolve with its correlated response (success may still be false). */
  request(cmd: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, any>>;
  /** Fire-and-forget command write. */
  send(cmd: Record<string, unknown>): void;
  onEvent(handler: (event: Record<string, any>) => void): void;
  onStderr(handler: (text: string) => void): void;
  /** Half-close stdin: a well-behaved child exits cleanly on EOF. */
  closeStdin(): void;
  kill(signal?: NodeJS.Signals): void;
  readonly exit: Promise<RpcExit>;
}

const REQUEST_TIMEOUT_MS = 10_000;

export function startRpcChild(command: string, args: string[], opts: { cwd: string }): RpcChild {
  const child: ChildProcess = spawn(command, args, {
    cwd: opts.cwd,
    detached: true, // own process group so group-wide kills work
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const eventHandlers: Array<(event: Record<string, any>) => void> = [];
  const stderrHandlers: Array<(text: string) => void> = [];
  const pending = new Map<string, { resolve: (value: Record<string, any>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  let buffer = "";
  let exited = false;
  let nextRequestId = 0;

  const failPending = (error: Error) => {
    for (const [, waiter] of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message: Record<string, any>;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // non-JSON noise on stdout — ignore
      }
      if (message.type === "response" && typeof message.id === "string" && pending.has(message.id)) {
        const waiter = pending.get(message.id)!;
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
        continue;
      }
      for (const handler of eventHandlers) handler(message);
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    for (const handler of stderrHandlers) handler(text);
  });

  let resolveExit: (value: RpcExit) => void = () => {};
  const exit = new Promise<RpcExit>((resolve) => { resolveExit = resolve; });
  child.on("close", (code, signal) => {
    exited = true;
    failPending(new Error("rpc child exited before responding"));
    resolveExit({ code, signal });
  });
  child.on("error", (error) => {
    exited = true;
    failPending(error);
    resolveExit({ code: 1, signal: null });
  });

  const write = (cmd: Record<string, unknown>): void => {
    child.stdin?.write(`${JSON.stringify(cmd)}\n`);
  };

  return {
    pid: child.pid ?? 0,
    get exited() { return exited; },
    request(cmd, timeoutMs = REQUEST_TIMEOUT_MS) {
      if (exited) return Promise.reject(new Error("rpc child already exited"));
      const id = `rpc-${++nextRequestId}`;
      return new Promise<Record<string, any>>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`rpc request timed out after ${timeoutMs}ms: ${String(cmd.type)}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          write({ id, ...cmd });
        } catch (error) {
          pending.delete(id);
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    send(cmd) {
      if (!exited) write(cmd);
    },
    onEvent(handler) { eventHandlers.push(handler); },
    onStderr(handler) { stderrHandlers.push(handler); },
    closeStdin() {
      try { child.stdin?.end(); } catch { /* already gone */ }
    },
    kill(signal = "SIGTERM") {
      try { child.kill(signal); } catch { /* already gone */ }
    },
    exit,
  };
}
