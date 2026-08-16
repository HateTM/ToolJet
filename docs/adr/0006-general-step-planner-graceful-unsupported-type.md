---
status: accepted
---

# Step planner is general from day one; unimplemented step types fail gracefully, not by restricting what the planner can propose

Ticket #4 only needs one step type to actually execute (`CreateTable`) — the acceptance scenario is a PRD whose plan is a single `CreateTable` step. But ADR-0002's v1 scope already promises three step shapes (`CreateComponent`, `CreateQuery`, `CreateTable`), and ADR-0004 fixes the plan's shape at approve time from whatever the PRD describes.

We could scope the step-planner prompt itself to only ever propose `CreateTable` steps for now, since that's all this ticket can execute. That's simpler short-term, but it's a throwaway constraint: the next PRD a real user approves will usually want a table *and* a query *and* some UI, and ticket #5 (which adds `CreateComponent`/`CreateQuery` execution) would have to redesign the planner prompt rather than just add a new case to a dispatch.

Decided: the step-planner LLM call (one call at `approvePrd`, per ADR-0004) is prompted with the full v1 step vocabulary and free to propose any mix of `CreateTable`/`CreateQuery`/`CreateComponent` steps, in order, matching what the PRD actually describes. Execution dispatches on `step.type`; only `CreateTable` has a real handler in this ticket. Any other type is treated as an **unsupported step type** — which is already an unrecoverable-failure case this ticket has to implement anyway (retry doesn't apply to it, since retrying an unimplemented handler can't succeed): already-succeeded Artifacts stay applied, and a failure message naming the unsupported step is posted to the conversation. This means a multi-step plan approved before ticket #5 ships will correctly build its table and then stop with a clear failure, instead of silently doing the wrong thing or blocking approval of any PRD that isn't table-only.

Ticket #5 removes the "unsupported" cases for `CreateComponent`/`CreateQuery` by adding real handlers — the planner prompt does not need to change.
