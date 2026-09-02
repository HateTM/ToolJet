# План: полный tool-паритет AI Builder (6 инкрементов)

Статус-трекер. Каждый инкремент — ветка `feature/<n>-...`, пушится в origin, тесты `npx jest --config jest-ai-unit.config.ts` + lint + ручной сценарий после каждого.

## 1. Token-usage (малый)

- [x] Захват `usage` из AI SDK (`AIGatewayGenerate`, стрим-пути) → `metadata.usage` ai-сообщения (jsonb, без миграций).
- [x] Эндпоинт `GET /ai/conversation/:id/token-usage` (сумма + breakdown), реализовать `getThreadTokenUsage`.
- [x] Фронт: индикатор расхода в футере чат-панели.

## 2. Промпт-библиотека из EE

- [ ] 29 файлов `ee-extract/server-ee-assets/ai/assets/prompt-library/` → `server/src/modules/ai/prompt-library/` + `index.ts` + `README.md` (подключено / ждёт задачу / deep-agent-only). Deep-agent payload не переносим.
- [ ] Подключение по семействам (коммит на семейство): updateQuery → query-update.ts; generateQuery/generateTJDBQuery → CREATE_QUERY_SYSTEM_PROMPT; generateEvent/updateEvent → GenerateEvent; fixWithAi → proposeFix; generateTablesPrompt/generateTJDBTables → CreateTable; generatePrd → планировщик. Тул-контракты не меняем; валидаторы форка — арбитры.
- [ ] Smoke-тест импорта библиотеки.

## 3. Все виджеты платформы (~40 типов)

Полный каталог из `frontend/src/AppBuilder/WidgetManager/configs/widgetConfig` вместо 12 типов.

- [ ] Волна 1 — простые: TextArea, PasswordInput, NumberInput, EmailInput, Link, Divider, Icon, StarRating, Statistics, Tags, CurrencyInput, PhoneInput, Datepicker и др.
- [ ] Волна 2 — сложные: Tabs, Listview, IFrame, FilePicker, ModalV2, PopoverMenu, ButtonGroupV2, DropdownV2, DatePickerV2, TreeSelect, Chat, Html (при риске — пометка «экспериментальный» в промпте).
- [ ] Для каждого: zod-вариант в `createComponentTool`, креатор в `agents.service.ts`, строка в промпте, запись в `SUPPORTED_COMPONENT_TYPES`.
- [ ] ADR-0026 «widget allow-list v2».

## 4. Update/Delete/Layout/Styles

- [ ] `sanitizeComponentSection` — TS-порт поверх `componentsMeta.json` (биндинги всегда валидны; невалид → дефолт + warn).
- [ ] `StepType.UpdateComponent`: tool «only modified keys», shallow-merge по секциям (вкл. styles), layout отдельным полем, артефакт с `previousState` → `undoUpdateComponent`.
- [ ] `StepType.UpdateEvent`: tool на базе `UpdateEventBody` + промпт `updateEvent`; валидация каталогом.
- [ ] `StepType.DeleteComponent` / `DeleteQuery`: tool'ы с подтверждением цели по id/имени; undo из артефакта.
- [ ] Layout/nesting: `parentComponentId` в tool'ах + `componentLayoutChange`; ограничения вложенности по widget-config.
- [ ] Планировщик разрешает новые типы шагов; ADR-0027 «diff-merge editing and lifecycle».

## 5. REST/plugin запросы

- [ ] `createQueryTool`: ветка `source: "restapi"` (url/method/headers/params/body) + generic `source: "plugin"` (pluginId + options по манифесту).
- [ ] Grounding: REST/plugin источники в connected-sources блоке (kind + подсказки манифеста).
- [ ] SQL read-only гейт не распространяется на REST/plugin; опции валидируются по манифесту.
- [ ] Промпты из библиотеки (`generateQuery`).

## 6. Interrupt-модель

- [ ] ADR-0028 + термины `Interrupt`/`Resume` в `CONTEXT.md`.
- [ ] SSE `interrupt` `{interruptId, type, payload, suggestions}`; V1: `clarify_prd`, `select_datasource`.
- [ ] Пауза — `conversation.metadata.interrupt` + suspend-точка в `approvePrd` (await/promise); ранн не снимается.
- [ ] `POST /ai/conversation/:id/interrupt-answer` — валидация, снятие паузы, ответ в LLM-контекст; повтор/чужой → 409.
- [ ] Фронт: обработка `interrupt` в `aiBuilderStore.js`, карточка вопроса (текст+чипы; пикер дата-сорсов), `interruptAnswer()` в `ai.service.js`.
- [ ] approve-prd сохраняется (ADR-0001).

## Не делаем

Создание дата-сорсов AI, SSE-hardening, кредиты per-операцию, отказ от approve-prd.
