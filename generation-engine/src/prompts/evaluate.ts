// transit copy from PR #93 (feature/93-generation-engine-prompt-library @ 9cf62c7d86) — dedupe at merge
// Placeholder — ticket #93 (docs/adr/0030). Issue #82's evaluate stage (LLM-as-judge
// post-processing) has no equivalent in the fork today. Content is left for the ticket
// that implements this stage; per issue #87's testing-strategy decision, LLM output
// quality is checked by hand and not gated by an automated eval pipeline, so this stage
// is judging generated output quality, not a test harness.
// TODO (#82): replace with the real evaluate system prompt.
export const EVALUATE_SYSTEM_PROMPT = `TODO (#82): evaluate (LLM-as-judge) stage system prompt — not yet implemented.`;
