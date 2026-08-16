---
status: accepted
---

# One generic `CreateComponent(type, props)` tool, not one tool per widget type

The existing stub `agents.service.ts` names one tool per target (`CreateTable`, `create_header_component`), and ToolJet has 60+ widget types. Following that naming pattern to cover "page, form, query, button, etc." would mean writing and maintaining dozens of near-identical tool implementations as the supported type list grows — a real scaling cost with no offsetting benefit, since the tools would differ only in which widget schema they validate against.

Decided: Steps that create a UI element go through one generic `CreateComponent(type, props)` tool, where `type` is constrained to an allow-list of supported widget types and `props` is validated against that widget's schema. `CreateTable` (ToolJet DB) and `CreateQuery` (data queries) stay as their own tools since they aren't components — they have distinct entities and permission surfaces. New widget types are added by extending the allow-list and schema, not by writing new tool code.

v1 allow-list for `CreateComponent`: Page, Table, Form, Button, Text, TextInput, Container. `CreateQuery` is restricted to the ToolJet DB data source for v1 — external data sources require credentials the AI cannot supply.
