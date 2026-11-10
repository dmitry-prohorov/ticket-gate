#!/usr/bin/env node
// PreToolUse hook for Claude Code: agents may push a feature branch and open
// or edit its PR, but never rewrite shared history or land code. Denied:
//   - `git push` with a force flag (-f, --force, --force-with-lease,
//     --force-if-includes), a `+refspec`, --mirror, --all, --prune or a delete
//     (-d, --delete, `:branch`);
//   - `git push` whose refspec targets main or master, or a bare `git push`
//     while main or master is checked out;
//   - `gh pr merge|close`, `gh repo sync`, and a writing `gh api` call;
//   - MCP git_push (it bypasses the refspec checks; push from Bash instead).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isMain } from '../is-main.mjs';

// Start of a command: line start or a shell separator, then optional sudo / command.
const PREFIX =
  String.raw`(?:^|&&|\|\||;|\||` +
  '`' +
  String.raw`|\$\(|\n)\s*(?:sudo\s+)?(?:command\s+)?`;
const SEPARATOR = /&&|\|\||;|\||\n/;

const GIT_PUSH = new RegExp(
  PREFIX + String.raw`git(?:\s+-[^\s]+(?:\s+[^\s-][^\s]*)?)*\s+push\b`,
  'gi',
);
const GH_WRITE = new RegExp(
  PREFIX +
    String.raw`gh(?:\s+-[^\s]+(?:\s+[^\s-][^\s]*)?)*\s+(?:pr\s+(?:merge|close)|repo\s+sync)\b`,
  'i',
);
const GH_API = new RegExp(
  PREFIX + String.raw`gh(?:\s+-[^\s]+(?:\s+[^\s-][^\s]*)?)*\s+api\b`,
  'gi',
);
// An explicit write method, or field / input flags, which make `gh api` default to POST.
const GH_API_WRITE =
  /(?:-X|--method)[\s=]*['"]?(?:POST|PUT|PATCH|DELETE)\b|\s(?:-f|-F|--field|--raw-field|--input)(?=[\s=]|$)/i;
const MCP_PUSH_TOOLS = new Set(['git_push', 'git push']);

const PUSH_DENY_FLAG =
  /^(?:-f|--force|--force-with-lease(?:=.*)?|--force-if-includes|--mirror|--all|--prune|-d|--delete)$/;
// Short-flag clusters such as -uf or -fu carry a force too.
const SHORT_CLUSTER_FORCE = /^-[a-z]*[fd][a-z]*$/i;

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Matches a protected branch name, literally, with or without refs/heads/. */
export function protectedPattern(names) {
  return new RegExp(
    String.raw`^(?:refs\/heads\/)?(?:${names.map(escapeRegExp).join('|')})$`,
  );
}

// Only for callers that pass no guard (unit tests); the hook always loads the config.
const DEFAULT_GUARD = { protected: protectedPattern(['main', 'master']) };

// A broken gate.config.mjs must deny every push and gh pr/repo/api call, never allow.
const FAIL_CLOSED = [
  new RegExp(
    PREFIX + String.raw`git(?:\s+-[^\s]+(?:\s+[^\s-][^\s]*)?)*\s+push\b`,
    'i',
  ),
  new RegExp(
    PREFIX +
      String.raw`gh(?:\s+-[^\s]+(?:\s+[^\s-][^\s]*)?)*\s+(?:pr|repo|api)\b`,
    'i',
  ),
];

/** Why a push / gh command is denied because the config could not be read, or null. */
export function failClosedDenial(command, error) {
  if (!FAIL_CLOSED.some((re) => re.test(command))) return null;
  return `gate.config.mjs is unusable (${error}); fix the key it names, or print the command for the user to run`;
}

/** The push guard from gate.config.mjs: { protected } or { error }. Never throws. */
export async function loadPushGuard() {
  try {
    const { loadGateConfig } = await import('../config.mjs');
    const config = await loadGateConfig();
    return { protected: protectedPattern(config.pushGuard.protected) };
  } catch (err) {
    return { error: String(err?.message ?? err) };
  }
}

const allow = () => process.exit(0);
const deny = (why) => {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Blocked by the ticket-gate push guard: ${why}. Agents may push a feature branch and open or edit its PR; they never force-push, delete a remote branch, push to main or master, merge or close a PR, sync a repo or make a writing gh api call. Do not retry another way; print the exact command for the user to run.`,
      },
    }),
  );
  process.exit(0);
};

/** This command's own arguments after the match: stop at the next separator. */
const argsAfter = (command, end) =>
  command.slice(end).split(SEPARATOR)[0].trim().split(/\s+/).filter(Boolean);

/** The branch checked out in the hook's working directory, or '' when unknown. */
function currentBranch() {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/** Why this `git push` argument list is denied, or null when it is allowed. */
export function pushDenial(args, branch, guard = DEFAULT_GUARD) {
  const positional = [];
  for (const a of args) {
    if (
      PUSH_DENY_FLAG.test(a) ||
      (!a.startsWith('--') && SHORT_CLUSTER_FORCE.test(a))
    )
      return `git push ${a}`;
    if (a.startsWith('-')) continue;
    positional.push(a.replace(/^['"]|['"]$/g, ''));
  }
  // positional[0] is the remote; the rest are refspecs.
  const refspecs = positional.slice(1);
  for (const r of refspecs) {
    if (r.startsWith('+')) return `force refspec ${r}`;
    if (r.startsWith(':')) return `delete refspec ${r}`;
    const dst = r.includes(':') ? r.slice(r.indexOf(':') + 1) : r;
    if (
      guard.protected.test(dst) ||
      (dst === 'HEAD' && guard.protected.test(branch))
    )
      return `push to ${dst === 'HEAD' ? branch : dst}`;
  }
  if (refspecs.length === 0 && guard.protected.test(branch))
    return `bare git push while ${branch} is checked out`;
  return null;
}

/** Why `command` is denied, or null when it is allowed. */
export function commandDenial(
  command,
  branch = currentBranch(),
  guard = DEFAULT_GUARD,
) {
  if (guard.error) return failClosedDenial(command, guard.error);
  for (const m of command.matchAll(GIT_PUSH)) {
    const why = pushDenial(
      argsAfter(command, m.index + m[0].length),
      branch,
      guard,
    );
    if (why) return why;
  }
  if (GH_WRITE.test(command)) return 'gh pr merge/close or gh repo sync';
  for (const m of command.matchAll(GH_API)) {
    const rest = command.slice(m.index + m[0].length).split(SEPARATOR)[0];
    if (GH_API_WRITE.test(rest)) return 'a writing gh api call';
  }
  return null;
}

export async function main() {
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    allow();
  }
  if (!raw.trim()) allow();

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    deny('unreadable hook payload');
  }
  if (!payload || typeof payload !== 'object') deny('unreadable hook payload');

  const tool = String(
    payload.tool_name ?? payload.toolName ?? payload.tool ?? '',
  ).toLowerCase();
  if (
    MCP_PUSH_TOOLS.has(tool) ||
    tool.endsWith('/git_push') ||
    tool.endsWith(':git_push') ||
    tool.endsWith('__git_push')
  )
    deny('MCP git_push (push from Bash so the refspec checks apply)');

  const input = payload.tool_input;
  let command = '';
  if (input && typeof input === 'object') {
    for (const key of ['command', 'cmd', 'script']) {
      if (typeof input[key] === 'string') {
        command = input[key];
        break;
      }
    }
  }
  const why = commandDenial(command, currentBranch(), await loadPushGuard());
  if (why) deny(why);
  allow();
}

if (isMain(import.meta.url)) await main();
