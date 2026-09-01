# ADR-0034: Generation engine testing — unit-test the deterministic scaffolding, eyeball the LLM output

Date: 2026-09-01
Ticket: #87 (testing strategy for the Generation engine)
Status: Accepted

## Context

The engine mixes deterministic code (tool-call parsing/validation, stage routing, schema serialization) with genuinely non-deterministic LLM output at every pipeline stage (ADR-0028). A testing strategy has to say what gets automated and what doesn't, and prompt content itself was deliberately left out of ADR-0030 to be settled here.

## Decision

**Unit tests** cover each stage's deterministic scaffolding — tool-call parsing/validation, stage routing/handoff, schema (de)serialization — the same way the rest of the fork is tested. **LLM output quality per stage is checked manually**, with no separate eval pipeline, no golden dataset, and no CI gate on prompt output.

This is a deliberate v1 choice, not an oversight: an eval pipeline is real infrastructure (golden datasets, judge prompts, drift monitoring) that isn't justified until manual review actually starts missing regressions.

## Consequences

- CI catches breakage in the deterministic plumbing but not prompt regressions or LLM output drift — those require a human to notice during manual testing/dogfooding.
- If manual checking starts letting regressions through, that's the trigger to revisit this ADR and add an eval pipeline — not something to build preemptively.
- The evaluate/LLM-as-judge pipeline stage (ADR-0028) is itself pipeline logic, not a substitute for prompt-quality testing infrastructure.
