# План: полный tool-паритет AI Builder (6 инкрементов)

Статус-трекер. Каждый инкремент — ветка `feature/<n>-...`, пушится в origin, тесты `npx jest --config jest-ai-unit.config.ts` + lint + ручной сценарий после каждого.

## 1. Token-usage (малый)

- [x] Захват `usage` из AI SDK (`AIGatewayGenerate`, стрим-пути) → `metadata.usage` ai-сообщения (jsonb, без миграций).
- [x] Эндпоинт `GET /ai/conversation/:id/token-usage` (сумма + breakdown), реализовать `getThreadTokenUsage`.
- [x] Фронт: индикатор расхода в футере чат-панели.

## 2. Промпт-библиотека из EE

- [x] 26 файлов `ee-extract/server-ee-assets/ai/assets/prompt-library/` → `server/src/modules/ai/prompt-library/` + `index.ts` + `README.md` (подключено / ждёт задачу / deep-agent-only). Deep-agent payload не переносим: в источнике 27 файлов, `translationprompt.ts` зависит от payload `agents.constants` — не перенесён.
- [x] Подключение по семействам (коммит на семейство): updateQuery → query-update.ts; generateQuery/generateTJDBQuery → CREATE_QUERY_SYSTEM_PROMPT; generateEvent/updateEvent → GenerateEvent; fixWithAi → proposeFix; generateTablesPrompt/generateTJDBTables → CreateTable; generatePrd → планировщик. Тул-контракты не меняем; валидаторы форка — арбитры. Без поломки контрактов подключены только updateQuery и generateQuery; остальные расходятся с контрактами форка и помечены «ждёт задачу» в `prompt-library/README.md`.
- [x] Smoke-тест импорта библиотеки (`server/test/modules/ai/unit/prompt-library.spec.ts`).

## 3. Все виджеты платформы (~40 типов)

Полный каталог из `frontend/src/AppBuilder/WidgetManager/configs/widgetConfig` вместо 12 типов.

- [x] Волна 1 — простые: TextArea, PasswordInput, NumberInput, EmailInput, Link, Divider, Icon, StarRating, Statistics, Tags, CurrencyInput, PhoneInput, Datepicker. `componentsMeta.json` для EE-совпадающих типов перенесён трансформацией EE-снапшота (см. ADR-0026); EmailInput/CurrencyInput/PhoneInput (форк-специфичные, в EE их нет) собраны вручную по образцу TextInput/NumberInput.
- [x] Волна 2 — сложные: Tabs, Listview, IFrame, FilePicker, ModalV2, PopoverMenu, ButtonGroupV2, DatePickerV2, TreeSelect, Chat, Html. DropdownV2 не потребовался отдельно — уже покрыт волной 0 (тип `Dropdown` создаёт компонент `DropdownV2`). Tabs/Listview/ModalV2 — standalone/empty (как Container/Modal): вложение дочерних виджетов не подключено, это увеличение 4. Chat помечен EXPERIMENTAL в промпте (только декоративный UI, без реального query/event на отправку сообщений).
- [x] Для каждого (волна 1 и 2): zod-вариант в `createComponentTool`, креатор в `agents.service.ts`, строка в промпте, запись в `SUPPORTED_COMPONENT_TYPES`.
- [x] ADR-0026 «widget allow-list v2» (описывает метод трансформации EE→CE meta; волна 2 переиспользовала тот же приём — 7 типов из EE-снапшота, 4 форк-специфичных вручную).

## 4. Update/Delete/Layout/Styles

- [x] `sanitizeComponentSection` — TS-порт поверх `componentsMeta.json` (биндинги всегда валидны; невалид → дефолт + warn). Уже реализован в `server/src/modules/ai/helpers/component-type-validator.ts` (тикет #60), до написания этого плана — `isTemplateExpression` проверяется в `valid`-выражении раньше вызова `isValidForSchema`, поэтому `{{...}}` никогда не подменяется дефолтом.
- [x] `StepType.UpdateComponent`: tool «only modified keys», shallow-merge по секциям (вкл. styles), layout отдельным полем, артефакт с `previousState` → `undoUpdateComponent`. Уже реализован (тикет #66/#99, коммит `59ce58634f`) — `component-update.helper.ts` (`wrapPatchSection`/`snapshotPreviousSection`/`isEmptyPatch`) + `AgentsService.UpdateComponent`/`undoUpdateComponent`. Layout как отдельное поле патча не входило в тикет #66 и не подключено — layout меняется только через отдельный `componentLayoutChange` вызов (см. п. «Layout/nesting» ниже).
- [x] `StepType.UpdateEvent`: tool на базе `UpdateEventBody` + промпт `updateEvent`; валидация каталогом. Функционально уже покрыто существующим `GenerateEvent`: `executeEventStep` апсертит по `eventId` — тот же `eventId` на том же компоненте обновляет существующий handler в конце (не дублирует), см. `agents.service.ts:2934` (сравнение `event.event.eventId === body.eventId`). Отдельный `StepType.UpdateEvent` не заведён — сочтено избыточным, апсерт уже даёт нужное поведение.
- [x] `StepType.DeleteComponent` / `DeleteQuery`: tool'ы с подтверждением цели по id/имени; undo из артефакта. Реализовано в этом инкременте (коммит `797099f69f`): `deleteComponentTool`/`deleteQueryTool`, `executeDeleteComponentStep`/`executeDeleteQueryStep`, `AgentsService.DeleteComponent`/`DeleteQuery` со снапшотом (компонент+layouts+events / query row) и `undoDeleteComponent`/`undoDeleteQuery`. Заодно исправлен пропуск `UpdateComponent` в реестре `generation-engine`'s `STEP_TYPES`, который расходился с фор-энтити `StepType`.
- [x] Layout/nesting (create-time, Container/Form only): `parentComponentId` — опциональное поле во всех 35 branch'ах `createComponentTool` (кроме `Page`). `createWidgetComponent` принимает `parentId?`, пишет его в `parent` (вместо всегда-`null`), а sibling-фильтр для layout-компакции теперь скоупится на `rect.parent === parentId` вместо `!rect.parent` — вложенные дети получают координаты в собственном пространстве родителя, не влияя и не завися от page-level siblings. `executeComponentStep` валидирует `parentComponentId` по `context.priorResults`: цель должна существовать в этом плане, на том же `pageId`, и быть типа `Container`/`Form` (ретраится так же, как невалидный `pageId`). `updateComponentTool` НЕ трогали (осознанное сужение скоупа — репэрентинг через Update увеличил бы undo-поверхность, тикет #66 сознательно вынес layout из патча). Slot-квалифицированные родители (Tabs — `${parentId}-${tab}`, ModalV2 header/footer — `${parentId}-header|footer`, формат подтверждён в `frontend/src/AppBuilder/AppCanvas/appCanvasUtils.js:396-410`) остаются вне скоупа — Tabs/Listview/ModalV2 как `parentComponentId` отклоняются валидацией и явно исключены из промпта. Тесты: `agents.service.spec.ts` (compaction скоупится на родителя, root siblings не влияют) + `service.spec.ts` (retry на hallucinated `parentComponentId`).
- [x] Планировщик разрешает новые типы шагов. Готово вместе с `DeleteComponent`/`DeleteQuery` (промпт + `STEP_TYPES`/`SUPPORTED_STEP_TYPES`, коммит `797099f69f`).
- [x] ADR «diff-merge editing and lifecycle» — номер 0027 уже занят (дважды, генерацией-engine и token-usage), оформлено как **ADR-0043** (`docs/adr/0043-component-lifecycle-and-create-time-nesting.md`): описывает и общий Update/Delete lifecycle (grounding → sparse diff → undo-snapshot), и решение по nesting из этого прохода (create-time only, Container/Form only, slot-контейнеры — сознательно вне скоупа).
- [x] Follow-up: ModalV2 slot-nesting (body/header/footer). `parentComponentId` теперь принимает `<modalId>` (body), `<modalId>-header`, `<modalId>-footer` — эти id уже используются канвасом как sub-container id (`ModalV2/Components/{Modal,Header,Footer}.jsx`), отдельного slot-поля не потребовалось. `executeComponentStep` (`service.ts`) парсит суффикс, резолвит базовый id, разрешает ModalV2 как parent (bare — любой slot; suffixed — только для ModalV2). `createWidgetComponent` (`agents.service.ts`) клэмпит высоту ребёнка до 30 grid-unit для header/footer (по умолчанию виджета вроде Table это снесло бы узкую полосу шапки/футера); body-слот не клэмпится. `showHeader`/`showFooter` по умолчанию `true` в `modalV2.js` — доп. свойств не требуется. Tabs/Listview остаются вне скоупа (свой механизм адресации). `updateComponentTool` не тронут (то же обоснование, что и раньше). Тесты: `service.spec.ts` (реальный Container с `-header` суффиксом отклоняется; ретрай на реальный `modal-1-header` проходит), `agents.service.spec.ts` (клэмп высоты для header-слота; отсутствие клэмпа для body-слота). ADR-0043 дополнен разделом «Follow-up».

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
