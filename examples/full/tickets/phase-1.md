# Phase 1

The Definition of Done of each ticket in this phase (`dod.files`). The Stop hook blocks an agent that
ticks a box here while the receipt of `ticket-gate verify` is missing, red or stale.

## T-2 Bulk discount

- [ ] `total()` takes 10% off from 10 items, and the mutation registry proves the test bites (`ticket-gate mutate T-2`)
- [ ] `ticket-gate verify` is green and its summary is in the pull request
- [ ] The discount banner is checked on staging (human)
