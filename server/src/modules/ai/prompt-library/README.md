# AI prompt library

> **Судьба библиотеки (2026-09-03, активный план `docs/superpowers/plans/2026-09-03-ai-builder-unification-part-1.md`):**
> эта библиотека — спящий дубликат. Владелец генерирующих промптов — `generation-engine/src/prompts/`
> (ADR-0050 сделает его единственным). В hard-switch PR библиотека удаляется целиком: подключённые
> `updateQuery.ts` и `generateQuery.ts` инлайнятся к потребителям вместе с форк-контрактными правилами,
> остальные 23 файла удаляются без замены — их смысл уже покрыт живыми промптами `service.ts` и движка.
> До того момента новые потребители здесь не появляются.

Порт промпт-библиотеки из EE (`ee-extract/server-ee-assets/ai/assets/prompt-library/`)
в CE-форк (план `docs/plans/2026-09-02-ai-builder-expansion.md`, инкремент 2).
Промпты — плоские функции, возвращающие строки; единственный изменённый при переносе
файл — исключён `translationprompt.ts` (см. ниже). Глубина текста сохранена как в EE.

Правила подключения (из плана): тул-контракты форка не меняются; валидаторы форка —
арбитры выходов LLM. Промпт библиотеки подключается к шагу только там, где он не
противоречит контракту тулa; расходящиеся семейства ждут отдельной задачи.

## Статусы

### Подключено

| Файл | Потребитель | Как |
|------|-------------|-----|
| `updateQuery.ts` | `services/query-update.ts` (`UPDATE_QUERY_SYSTEM_PROMPT`) | библиотечный `systemPrompt()` как база + контрактные правила форка (target по имени, только изменившиеся ключи, read-only SQL, синтаксис биндингов) |
| `generateQuery.ts` | `service.ts` (`CREATE_QUERY_SYSTEM_PROMPT`) | библиотечная фрейминг-строка как база + контракт тулa `createQuery` (`tooljetdb` list_rows / `sql` SELECT) |

### Ждёт задачу (перенесён, не подключён — расходится с контрактом форка)

| Файл | Расхождение |
|------|-------------|
| `generateTJDBQuery.ts` | описывает генерацию полного `ToolJetDBQuery` JSON (все 4 операции); тул форка принимает только `name + table_id` (list_rows) |
| `generateEvent.ts` | `taskPrompt` содержит вшитый застывший EE-каталог событий; у форка машинный каталог через `renderEventCatalogForPrompt()` |
| `updateEvent.ts` | в форке ещё нет шага `UpdateEvent` (инкремент 4 плана); подключить при вводе шага |
| `fixWithAiPrompt.ts` | формат выхода EE (`fixRequired`/`diagnosis`/`fix[]`) несовместим с тулом `proposeFix` (`fixedValue` + `explanation`) |
| `generateTablesPrompt.ts` | потребляет PRD в формате EE (JSON-массив секций); у форка PRD — чат-текст (ADR-0001) |
| `generateTJDBTables.ts` | конвертер SQL→TJDB с суффиксом имён; тул `createTable` форка создаёт одну таблицу с FK/indexes (ADR-0020/#23) |
| `generatePrd.ts` | PRD в формате EE (JSON-массив `sectionName`/`header`/`design` с color-picker); контракты форка — чат-PRD (ADR-0001) и `STEP_PLAN_SYSTEM_PROMPT` |
| `generateLayout.ts` | читает `assets/layoutExample.json` относительно `__dirname` (перенесён из EE, копи-правило в `nest-cli.json`); не подключён — относится к LLD/components-agent конвейеру (инкременты 3–4) |
| `generateComponent.ts`, `updateComponent.ts`, `componentsAgent.ts`, `evaluatePrompt.ts`, `featureAnalysis.ts`, `featurePlanner.ts`, `siblingLayoutOptimise.ts`, `generateTodoList.ts`, `generateDummySchema.ts`, `describeAppClassifierPrompt.ts`, `generateLLDPrompt.ts`, `applicationNameSimilarityCheckPrompt.ts` | относятся к EE-конвейеру LLD/components-agent (инкременты 3–4 плана: полный каталог виджетов, Update/Delete/Layout). Подключать по мере ввода соответствующих шагов |

### Не переносим (deep-agent payload)

- `translationprompt.ts` — импортирует `TooljetComponentData`/`TooljetEvents` из
  `../agents/agents.constants`, это ~8,7k строк payload-данных deep-agent (base64-ассеты,
  словари компонентов). План запрещает переносить payload.

### Без экспорта из index.ts (скопированы для полноты)

`dataSourcePrompts.ts`, `lldGenerationPrompt.ts`, `processFeaturePrompt.ts` —
в EE index не экспортировались, статус «ждёт задачу».

## Smoke-тест

`server/test/modules/ai/unit/prompt-library.spec.ts` — импортирует `index.ts` и
проверяет, что все экспорты резолвятся и возвращают непустые строки.
