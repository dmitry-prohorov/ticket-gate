// Types for lock.mjs, the stack lock shared by the gate, the nightly and the profiler.
export interface LockHolder {
  owner: string;
  pid: number;
  id: string;
  startedAt: string;
  cwd: string;
  nested?: boolean;
  [key: string]: unknown;
}
export interface LockOptions {
  now?: () => number;
  alive?: (pid: number) => boolean;
  env?: NodeJS.ProcessEnv;
}
export type TakeResult =
  | { ok: true; holder: LockHolder; nested?: boolean }
  | { ok: false; holder: LockHolder };
export interface GateLock {
  acquire(): { ok: boolean; [key: string]: unknown };
  release(): void;
  [key: string]: unknown;
}

export const OWNERS: string[];
export const STALE_EMPTY_MS: number;
export const WAIT_S: number;
export const POLL_S: number;
export const PRINT_S: number;

export function mainCheckout(cwd?: string): string;
export function lockPath(
  cwd?: string,
  opts?: { env?: NodeJS.ProcessEnv },
): string;
export function isAlive(pid: number): boolean;
export function readLock(
  path: string,
  opts?: { now?: () => number },
): LockHolder | null;
export function readReleased(path: string): Record<string, unknown> | null;
export function reapStale(path: string, opts?: LockOptions): boolean;
export function tryTake(
  path: string,
  opts: LockOptions & { owner: string; cwd?: string; pid?: number },
): TakeResult;
export function release(
  path: string,
  holder: LockHolder,
  opts?: { now?: () => number },
): boolean;
export function heldByOther(path: string, opts?: LockOptions): LockHolder | null;
export function holderLine(holder: LockHolder): string;
export function refuseIfHeld(path?: string, opts?: LockOptions): void;
export function takeOrExit(
  owner: string,
  opts?: {
    path?: string;
    exit?: (code: number) => unknown;
    log?: (line: string) => void;
  },
): LockHolder;
export function sleepSync(ms: number): void;
export function gateLock(opts?: {
  path?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  sleep?: (ms: number) => void;
  log?: (line: string) => void;
  alive?: (pid: number) => boolean;
  commands?: Record<string, unknown>;
}): GateLock;
