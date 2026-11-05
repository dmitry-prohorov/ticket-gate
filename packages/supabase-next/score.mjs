// The base-worktree install of a pnpm workspace package: the `baseInstall` a score
// config needs, built from the package name or filter pattern.

/**
 * A `score.baseInstall` that installs `filter` and the packages it depends on, frozen
 * to the lockfile. The marker is written only after a successful install.
 */
export function pnpmFilterInstall(filter) {
  if (typeof filter !== "string" || filter === "" || /[\s'"`]/.test(filter))
    throw new Error(
      "pnpmFilterInstall: filter must be a package name or pattern",
    );
  return {
    cmd: "pnpm",
    args: [
      "install",
      "--frozen-lockfile",
      "--prefer-offline",
      "--filter",
      `${filter}...`,
    ],
    label: "pnpm install",
    hint: `pnpm install --frozen-lockfile --filter '${filter}...'`,
    marker: ".ticket-gate-install-done",
  };
}
