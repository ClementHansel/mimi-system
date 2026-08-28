# Linear — how progress gets tracked

Workspace `xmljson` · team **Mimi Chicken**, key **`MA`** · project **Mimi Chicken Business OS**.

Issues are `MA-1`, `MA-2`, … The team is what owns issues and mints those ids; the
project is a grouping laid over them. Both matter, but only the team can be imported into.

## 1. The two integrations, and what each one does

| | Direction | What it does | Setup |
| --- | --- | --- | --- |
| **GitHub integration** | Linear watches the repo | Moves an issue's state automatically from branch and PR activity | Linear → Settings → Integrations → GitHub, connect `ClementHansel/mimi-system` |
| **Linear MCP** | Claude Code talks to Linear | Read a ticket, comment evidence, move state, open sub-issues | create `.mcp.json` locally (see below); `/mcp` → `linear` → Authenticate |

These are independent. The GitHub side is the automatic state machine; MCP is how
narrative progress and QA evidence get written.

### MCP first-run

**`.mcp.json` is gitignored** (`dca8f71` — MCP wiring is per-machine config, not
something every clone should inherit). So a fresh clone has no Linear connection
until you create it. Write this at the repo root:

```json
{ "mcpServers": { "linear": { "type": "http", "url": "https://mcp.linear.app/mcp" } } }
```

Then, because MCP servers are registered **at launch**:

1. Restart Claude Code in this directory.
2. Approve the project MCP servers when prompted — approval is per-project.
3. `/mcp` → `linear` → **Authenticate**.

Two things that actually went wrong the first time, both worth avoiding:

- **`/mcp` is typed at the Claude Code prompt**, not in PowerShell. The shell will
  tell you `/mcp` is not a recognised command.
- **Check the workspace on Linear's consent screen.** It defaults to whichever
  workspace the browser is currently in, and the first authorisation landed on a
  different one entirely. Open `https://linear.app/xmljson` first, then authorise.
  Verify with `get_workspace` — you want `Xmljson`, not another workspace.

## 2. Branch naming — this is what drives the automation

Put the issue id in the branch name. Linear matches on it; without it nothing moves.

```
greedybugz/ma-171-b-13-approval-notifications-point-at-a-route
ma-122-cross-suite-seed-invariant
```

Linear's own "Copy git branch name" button emits `<username>/ma-<number>-<slug>` — that is
what the API returns as `gitBranchName`, and using the button is the safest option. A bare
`ma-<number>-<slug>` works too: Linear matches on the **issue id appearing anywhere in the
branch name**, not on the whole shape.

What does not work is a branch with no id at all.

Historic branches (`delivery-nav`, `driver-skip-and-photo`, `perf-usernames`) predate
this and carry no id. Leave them; the convention applies going forward.

### PR magic words

In the PR **title or description**:

```
Fixes MA-13
Closes MA-13
Resolves MA-13
```

Several ids are fine — one per line. The exact state each transition targets is
configurable per-team in Linear's GitHub integration settings; the defaults are
branch pushed → In Progress, PR opened → In Review, PR merged → Done.

## 3. Status mapping

The tracker's legend maps onto Linear states like this:

| `docs/PROGRESS.md` | Linear |
| --- | --- |
| `[x]` done & verified | Done |
| `[~]` in flight | In Progress |
| `[ ]` not started | Todo |
| `[!]` blocked | Todo, plus a `blocked` label |
| Technical debt (`D-nn`) | Backlog |

## 4. QA flow — evidence lives in a sub-issue

QA does **not** post into the parent ticket's thread. Each ticket that needs
verification gets a linked **QA sub-issue** holding the test evidence, so the parent
stays readable.

1. Parent `MA-n` reaches In Progress and the work lands.
2. Open a sub-issue of `MA-n` titled `QA: <parent title>`.
3. The `qa` agent runs the suite **and** drives the affected flow end to end, then
   writes what it actually ran into the sub-issue — commands, counts, screenshots.
4. Sub-issue Done → parent may move to Done. Sub-issue fails → parent returns to
   In Progress with the failure named.

### The rule that makes this worth doing

Carried over from the AIRIN workspace, where it was learned expensively:

> **Code-fixed ≠ closable.** Do not close on a code read. Require a live run per ticket.

Precedent there: two tickets were reported fixed while still broken, because a green
test suite was asserting the wrong thing. A related rule from the same workspace:
**read the ticket description, not just the title** — two rounds of work went at the
wrong cause because the title alone sounded like a data bug.

This matters immediately: the initial import brings in **76 issues already marked
Done**, and that status comes from a *document*, not from a run. Treat imported
Done as a claim to be verified, not as verified.

## 5. What is in the team, and where it came from

The team holds two distinct populations. They are different **axes**, not duplicates:

| Range | What | Count | Origin |
| --- | --- | --- | --- |
| `MA-5`…`MA-120` | PRD requirements — `FR-*`/`NFR-*` plus 9 section parents | 116 | the PRD, authored in Linear |
| `MA-121`…`MA-176` | Engineering register — blockers, debt, risks | 56 | migrated from `PROGRESS.md` |
| `MA-1`…`MA-4` | Linear onboarding stubs | 4 | cancelled 2026-08-24 |

The requirements say *what the system must do*. The migrated set says *what is wrong with it
and what it owes*. Each requirement issue carries a **Specification** and **Acceptance
Criteria** block — that is the QA input.

### The migrated 56

Extracted mechanically by `scripts/linear-import-extract.mjs` — 20 blockers (`B-nn`), 30
technical-debt items (`D-nn`), 6 risks. Labels: `blocker` / `debt` / `risk`, plus
`from-progress-md` on all of them. Every body ends with the source section and line number
plus its legacy id, so any ticket traces back.

Not migrated: the **66 wave tasks** (`W0-A`…`W7-05`, `F-*`, `FIX-*`). They are the build
plan, they overlap the requirement register conceptually, and importing them would have put
two taxonomies on one system. They stay in the frozen `PROGRESS.md`.

### Defects in the source, preserved rather than silently fixed

- The tracker's **"67 tasks" total is 66** — `F-DOCS` is counted under Wave 5c *and* as
  `W7-03` under Wave 7. One task, counted twice.
- **`B-05` contradicts itself** — the Wave 3 gate marks it resolved, §2 lists it open. Both
  statements are recorded in `MA-122`; it needs a decision.
- **`D-02` nearly imported as Done** because its text contains "(auth ✅ done)" — a note that
  *one part* is finished. Only a tick in the ID cell means resolved. Caught before import.

### NFR status pass (2026-08-24)

The 10 NFR issues were assessed against `docs/ACCEPTANCE.md`; each carries a comment showing
the evidence and the reasoning. Only **NFR-10** was closed. `NFR-01` (never measured) and
`NFR-06` (no offsite backup, and the nightly backup had never run) are explicitly open;
`NFR-03`, `07` and `09` are In Progress with named gaps; `NFR-02`, `04`, `05`, `08` have no
recorded evidence and were left alone.

The ~106 `FR-*` issues were **not** touched. Unlike the NFRs they have no evidence mapping —
only four `FR` ids appear anywhere in the engineering docs — so setting their status would be
guesswork, not migration.

## 6. Linear is authoritative (decided 2026-08-24)

`docs/PROGRESS.md` is **frozen** and carries a banner saying so. It is a historical
record: do not update it, and do not read it for current state.

Both held the same 128 facts, and maintaining two trackers by hand is how they drift.
Linear wins because it is the one the automation can actually write to.

What still points back at the frozen file, legitimately:

- Source comments citing named incidents ("THE BIG ONE", `B-08`, `B-16`) — these are
  references to a historical writeup and stay accurate.
- `docs/BUILD-PLAN.md` §6 gate procedure and `docs/TECHNICAL.md` — the gate procedure
  itself is still in force; only the task/blocker state moved.
