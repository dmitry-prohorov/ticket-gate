# Follow-ups

One file per follow-up, `FU<n>.md`, with a front matter of `id`, `status` (`open` or `done`), `severity`, `owner` and
`fixed-in`, and the description as the body:

```md
---
id: FU2
status: open
severity: medium
owner: dev-ui
fixed-in: none
---
What is left to do, and why it was not done in the ticket that found it.
```

`npx ticket-gate fu next` prints the next free id; `fu list`, `fu show <id>` and `fu close <id> --by <TICKET> --sha <sha>`
read and update the register; `fu check` validates it.
