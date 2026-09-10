// Low-priority wrapper argv for spawned children (subagent rpc children,
// background tasks): `nice -n 15` everywhere; `ionice -c3` ONLY where the
// binary exists (Linux util-linux). macOS has no ionice — hardcoding it there
// makes `nice` fail its exec with ENOENT (exit 127) before the real command
// ever starts, which surfaced as "rpc child exited before responding".
//
// The availability probe runs once per extension instance and is cached; it is
// a pure environment fact, not ownership state, so it deliberately does NOT go
// on globalThis (unlike bg-task's api/seq registries).

import { spawnSync } from "node:child_process";

let ioniceAvailable: boolean | undefined;

function probeIonice(): boolean {
  if (ioniceAvailable === undefined) {
    const probe = spawnSync("ionice", ["-c3", "true"], { stdio: "ignore" });
    ioniceAvailable = !probe.error;
  }
  return ioniceAvailable;
}

/**
 * Wrap an argv so the child runs at lowest scheduling priority.
 * Input: the real command + args. Output: priority-prefixed argv ready for
 * `spawn()`/rpc child start.
 */
export function lowPrio(argv: string[]): string[] {
  return probeIonice()
    ? ["nice", "-n", "15", "ionice", "-c3", ...argv]
    : ["nice", "-n", "15", ...argv];
}
