---
status: accepted
---

# `Fix with AI` is scoped to failing property expressions; free-form copilot autocomplete is a separate track

Ticket #11's title names two features that the deferred-features list had lumped together — "copilot" and "fix with AI" — and asked where the inline affordance should surface. They turn out to be two genuinely different products that happen to both put an AI button near a code editor, and the existing CE codebase already tells them apart.

**Fix with AI** is error-driven. `PreviewBox` already renders an error banner whenever a property expression fails to resolve, already gates an "Auto-fix" button behind `state.ai.aiFeaturesEnabled`, already mounts a `FixWithAi` popover with `onApplyFix`/`onRetry`/`onClose`, and already calls `fetchErrorFixUsingAi(errorData, meta)` with the failing expression, the resolver's message, and the property's fallback value. `SingleLineCodeEditor`/`MultiLineCodeEditor` already implement `onAiSuggestionAccept(newValue)`, which writes a value straight back into the field. The whole affordance exists in CE as three empty holes: `FixWithAi` returns `<></>`, `createFixWithAiSlice` resolves to `() => ({})` for the `ce` edition, and `POST /ai/fix-with-ai` — which `aiService.fixWithAI` already calls — has no route.

**Copilot** is free-form: a prompt-driven code-completion button inside the JS/Python query editors, threaded through as `renderCopilot` from `DynamicForm` → `QueryManagerBody` → `CodeHinter` → `MultiLineCodeEditor`. In CE that prop is `null` at every call site, and the legacy `copilotService` it was built for points at a hosted `POST /copilot` endpoint requiring a separate ToolJet-issued API key (`validateCopilotAPIKey`) that this self-hosted fork has no counterpart for.

Decided: this ticket implements only `Fix with AI`, and only where an error is already being displayed — the CodeHinter preview popover on a component property. That is the surface with a real trigger (a resolution failure), a real apply seam (`onAiSuggestionAccept`), and a real, already-wired feature gate. Copilot needs its own answers to questions this ticket does not have to settle — what triggers a completion when nothing is wrong, how much of the app's bindings become prompt context, what replaces the dead API-key flow — so it stays deferred as its own ticket rather than being half-built here.

The cost is that "AI help in the query editor" still doesn't exist: a user writing a `runjs` transformation gets no assistance unless it throws. That's accepted. An error is what makes this feature's context precise — there is exactly one failing expression, one error message, and one field to write the answer into — and that precision is what lets the suggestion be applied with a single click instead of reviewed as a diff.
