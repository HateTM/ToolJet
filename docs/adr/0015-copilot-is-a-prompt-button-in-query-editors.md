---
status: accepted
---

# `Copilot` is a prompt-driven button in the query editors, not inline ghost text

`Fix with AI` had its trigger handed to it: a property expression fails to resolve, an error banner is already on screen, and the button belongs in that banner (ADR-0013). `Copilot` has no such moment. Nothing is wrong when a user is writing a `runjs` body, so ticket #33 had to answer what asks for a completion in the first place — a toolbar button, a keystroke, a prompt input, or ghost text appearing inline as the user types.

The CE codebase already answers most of it. `renderCopilot` is threaded `DynamicForm` → `QueryManagerBody` → `CodeHinter` → `MultiLineCodeEditor`, and what `MultiLineCodeEditor` does with it is call it for a `copilotBtnSlot` that `CodeHinterBtns` renders next to the search button in the editor's overlay controls. That is a **button** slot, positioned, styled, and already accounted for in the editor's layout (`has-overlay-controls` widens the gutter when the slot is filled). It also receives `onAiSuggestionAccept`, the same write-back seam `Fix with AI` applies through.

Decided: the trigger is that button. Clicking it opens a popover with a free-text prompt input; the user describes what the code should do and asks for it. Nothing fires without an explicit request — no keystroke listener, no debounce, no completion the user did not ask for.

Inline ghost text was the real alternative and was rejected on cost. It is not a different renderer for the same feature — it needs a CodeMirror inline-completion extension, a per-keystroke debounce-and-cancel model, and an accept/reject keymap that has to coexist with the editor's existing autocomplete, search panel, and `queryPanelKeybindings`. It also changes the request profile completely: an LLM call every few hundred milliseconds against a self-hosted LocalAI whose latency this fork does not control and does not measure. A button costs one call per deliberate ask.

Scope of surfaces is settled the same way, but by a tighter test than "wherever the prop reaches": **the JavaScript and Python query editors** — `runjs`, `runpy`, and query `Transformation`s.

`renderCopilot` reaches further than that on its own. `DynamicForm` hands it to every multi-line `codehinter` field a plugin declares, and `postgresql`'s `operations.json` declares one with `mode: "sql"` — so the prop alone would put the button in SQL editors too. It does not belong there: the system prompt describes the JS/Python query runtime (`queries.<name>.run()`, an explicit `return` from the body), so a completion for a SQL field would be JavaScript in a SQL box. The button therefore gates on the editor's own language and simply does not render for a language it cannot answer in, rather than the prompt being widened to cover every dialect a plugin might use.

Extending it to every multi-line `CodeHinter` is rejected for a separate reason: that would put it on component properties, where a multi-line generated body is the wrong shape for a field holding one binding expression, and where the error-driven `Fix with AI` already covers the case that has a precise answer. A later ticket can widen either boundary — teaching the prompt SQL is a prompt-and-gate change, not a redesign.

The cost is that a user who wants help must stop and ask for it in words, which is strictly more friction than a completion that appears on its own. That is accepted: this feature's value is "write the thing I am describing", and a prompt is how the description gets in. The seam that makes ghost text possible — `editorRef` is handed to `renderCopilot` alongside `onAiSuggestionAccept` — is left untouched, so overturning this ADR later means adding an extension, not unpicking one.
