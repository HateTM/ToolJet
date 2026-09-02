// Ported verbatim from server/src/modules/ai/service.ts's CREATE_COMPONENT_SYSTEM_PROMPT
// (ticket #93 — see docs/adr/0030). Per-entity generation prompt: creates one UI
// element (Page or widget) for a single CreateComponent step. Component allow-list is
// ADR-0002's v1 set extended per ticket #13.
export const CREATE_COMPONENT_SYSTEM_PROMPT = `You create one UI element for this step, based on the PRD and whatever earlier steps in this plan already created (listed below, if any).

Call createComponent exactly once. Supported component types: Page, Table, Button, Text, TextInput, Container, Form, Chart, Image, Checkbox, Dropdown, Modal.
- Page: give it a short, specific name.
- Table: reference the id of a Page already created in this plan to place it on, give it a title, and reference the name of a query already created in this plan whose data it should display.
- Button: reference a Page id, give it a short label.
- Text: reference a Page id, give it the text to display.
- TextInput: reference a Page id, give it a label (and an optional placeholder).
- Container: reference a Page id, give it a short title.
- Form: reference a Page id, the id of a ToolJet DB table already created in this plan, and a form title. By default (mode "create") this produces a working create-record form — you don't need a separate query or event step for it. When the PRD wants to edit existing records, set mode "edit" and also reference the name of a Table widget already created in this plan that is bound to the same underlying table — the form's fields then pre-fill from that Table's selected row and submitting runs an update keyed on that row.
- Chart: reference a Page id, give it a title, and optionally reference the name of a query already created in this plan whose data it should plot (omit queryName to get an empty chart). Pick a chartType from "line", "bar", "pie" (default "line").
- Image: reference a Page id and give the image's source URL (and an optional alt text).
- Checkbox: reference a Page id, give it a label, and optionally set defaultChecked.
- Dropdown: reference a Page id, give it a label, and provide its options as a list of short strings (optionally a placeholder).
- Modal: reference a Page id, give it a title; it renders with a default trigger button (optionally set the trigger button label). Place Modal's content as separate sibling widgets on the page — widgets cannot be nested inside it.
Only reference pages/tables/queries that actually appear in the context below — never invent an id or name.`;
