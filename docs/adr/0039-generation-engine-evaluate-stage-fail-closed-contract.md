# ADR-0039: Evaluate stage's pass/fail contract is fail-closed, non-throwing

Date: 2026-09-01
Ticket: #95 (Generation engine pipeline stages)
Status: Accepted

## Context

ADR-0028 puts an LLM-as-judge "evaluate" stage last in the pipeline but leaves its
"concrete pass/fail contract with the rest of the pipeline... to implementation, not
fixed by this ADR." Issue #95's own acceptance criteria require that contract to be
documented, not just implemented. Two things need deciding: what happens when the
judge's output can't be parsed, and whether a failing verdict halts the pipeline itself.

Numbered 0037 (not reusing 0027/0036, both already double-claimed by unmerged sibling
branches per #92's and #94's own PR notes) — flagged for renumbering at merge time,
consistent with that existing precedent in this repo.

## Decision

1. **Fail-closed parsing.** `parseEvaluationVerdict` (`generation-engine/src/pipeline/
   evaluate.ts`) treats any judge response that isn't a well-formed
   `{ pass: boolean, reasons: string[] }` object as `{ pass: false, reasons: [...] }`,
   never as an implicit pass. An LLM judge is exactly the kind of dependency whose
   failure mode (malformed JSON, refusal, truncation) must not be silently interpreted
   as approval.
2. **The stage itself does not throw on a failing verdict.** It records `evaluation` on
   the pipeline artifacts and returns normally. Whether a `pass: false` verdict blocks
   downstream consumption (e.g. surfacing the app to the user, retrying a stage) is a
   caller decision, not baked into the pipeline's control flow — the same evaluate stage
   is reusable by both an interactive flow (which might retry) and a batch/CI flow (which
   might just log).

## Consequences

- A caller that ignores `artifacts.evaluation` entirely gets no protection — the stage
  is a signal, not an enforcement point. Whichever ticket wires the evaluate stage into
  the server-facing flow (out of scope here; #95 is deterministic scaffolding only, per
  ADR-0034) owns the decision of what to do with a failing verdict.
- Parse failures (a judge that returns prose instead of JSON, for instance) are
  indistinguishable from a genuine `pass: false` at the type level — both come back as
  `{ pass: false, reasons: [...] }`. `reasons` distinguishes them in practice (a parse
  failure's reason names the parse problem, not a content issue), but nothing currently
  enforces that distinction structurally.
- Per ADR-0034, this ADR governs only the deterministic parsing/contract half; the
  judge prompt's actual quality is checked manually, not by this contract.
