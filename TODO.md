# TODO

## Azure DevOps host support (deferred)

Deferred until a consuming project has Azure Pipelines available. Background: [docs/why.md](docs/why.md).

- [ ] Push-guard host adapters: a `pushGuard.hosts` config key (`github`, `azure-devops`; all known hosts on when the
      key is absent; an unknown name fails closed). The GitHub adapter keeps today's behaviour and every existing case.
- [ ] Azure DevOps deny set, for `az` and for the `git pr` / `git repo` aliases:
  - PR completion: `pr update --status`; `--auto-complete` or `--bypass-policy` with any value other than `false`; `pr set-vote`.
  - Repository administration: `repos policy` and `devops security` writes; `repos ref delete|lock|unlock`; `repos create|delete|update|import`.
  - Writing `az devops invoke` and `az rest` calls.
  - `az pipelines run|create|update|delete`, `build queue`, `release create`, and variable and variable-group writes.
- [ ] Base resolution: every base lookup honours `config.base`, and `verify` exits 2 when no base resolves. Today it
      silently diffs against HEAD, so a shallow CI checkout (the Azure Pipelines default) passes on an empty diff.
- [ ] Server side, once Pipelines are available: a branch policy on `main` (pull request required, votes reset on
      push, required build validation running `ticket-gate verify`, force push and bypass denied). The local hook stays
      the merge guard while agents run with the owner's credentials.
- [ ] Cursor hook: the push guard for Cursor is a separate script and recognises GitHub only. Port it when a second
      Cursor user needs it.
- [ ] Check Azure's pull request description length limit against the size of the generated summary.
