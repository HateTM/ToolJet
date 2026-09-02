# Code review: PR #124 — ai: port EE prompt library under modules/ai (plan increment 2)

- **Дата**: 2026-09-02
- **Дифф**: `git diff 103409a4ce...HEAD` (коммит ab948fb3f1, merged в `main`)
- **Спека**: body PR/issue #124 + `docs/plans/2026-09-02-ai-builder-expansion.md` (increment 2)
- **Охват**: 32 файла, +5619/−13; в основном новые файлы в `server/src/modules/ai/prompt-library/`, копи-правило ассетов в `nest-cli.json`, врезки в `service.ts` / `services/query-update.ts`, smoke-спека.
- **Метод**: две оси ревью (Standards / Spec) параллельными субагентами; итоги сведены без перенормировки.

## Standards

Хард-нарушений документированных стандартов нет: секретов нет, SQL нет, абсолютный путь из EE корректно заменён на серверный ассет (`path.join(__dirname, 'assets/layoutExample.json')` + копи-правило в `nest-cli.json`), импорты в пределах модуля, `tsconfig.json` без `noImplicitAny` компилирует нетипизированные параметры промптов.

**Вердикт: SHIP.** Находки (все — judgement calls, кроме особо отмеченных):

1. **README противоречит коду** — `prompt-library/README.md`, строка про `generateLayout` в таблице «Ждёт задачу»: утверждает, что файл читает `layoutExample` по зашитому абсолютному пути (`fs.readFileSync('/Users/...')`) и «перед подключением нужен перенос в ассеты». Но порт это уже сделал: `generateLayout.ts:7-8` резолвит ассет относительно `__dirname`, копи-правило добавлено. Починить устаревшую строку.
2. `dataSourcePrompts.ts:129-139` — `dataSourcePrompt(dataSource)` возвращает `undefined` для типов, отличных от `tooljetdb`/`postgresql`, и использует свободное `==`. Файл — мёртвый код (намеренно не экспортируется), но дефект латентный: включится при первом же врезании.
3. `service.ts:640-641` — прифреймленный `generateQuery.systemPrompt()` требует «Always return json… Do not include any additional text or explanations», что может конфликтовать с tool-call контрактом `createQuery`, добавляемым ниже в тот же system prompt. Инлайн-комментарий divergence признаёт; нужна A/B-проверка на рантайме.
4. **Speculative Generality** — ~1700 строк неэкспортируемых/неиспользуемых prompt-файлов (`dataSourcePrompts.ts`, `lldGenerationPrompt.ts`, `processFeaturePrompt.ts` и ~20 namespace без потребителей). Смягчено: README декларирует намеренный faithful-порт под инкременты 3–4 плана; стандарт «минимальные изменения»/plan-driven портирование перекрывает smell.
5. **Mysterious Name** — namespace `generateDummyData` экспортируется из `generateDummySchema.ts` (`index.ts:26`); нейминг по библиотеке непоследователен (`fixWithAi` из `fixWithAiPrompt.ts`, `describeAppClassifier` из `describeAppClassifierPrompt.ts`). Артефакт верного порта.
6. Smoke-спека `server/test/modules/ai/unit/prompt-library.spec.ts:41-52` вызывает только `promptFns[0]` с `{}`: мультиаргументные промпты (например `updateQuery.taskPrompt`) проверяются вакуумно, сломанный второй промпт в namespace поймать не сможет. Приемлемо как заявленный smoke, но покрытия мало.
7. `dataSourcePrompts.ts` содержит битые JSON-примеры в тексте промптов (`"neq"not equal to"`, `" sampleData"`, «tolljet»). Verbatim-порт; деградирует вывод модели, если файл когда-нибудь подключат.

## Spec

Все ключевые пункты спеки подтверждены:

- `translationprompt.ts` действительно не портирован (как и обещано — deep-agent payload dependency).
- `assets/layoutExample.json` существует; `nest-cli.json` содержит копи-правило `modules/ai/prompt-library/assets/**/*` → `./dist/src`.
- `updateQuery.systemPrompt()` вшит в `UPDATE_QUERY_SYSTEM_PROMPT` (`services/query-update.ts`).
- `generateQuery.systemPrompt()` вшит в `CREATE_QUERY_SYSTEM_PROMPT` (`service.ts`).
- Ожидающие семейства (generateTJDBQuery, generateEvent, updateEvent, fixWithAiPrompt, generateTablesPrompt, generateTJDBTables, generatePrd, generateLayout, LLD pipeline batch) задокументированы в `prompt-library/README.md`.
- Smoke-спека существует и покрывает экспорты `index.ts` один-в-один; 23 passed при прогоне.

**Вердикт: FIX-FIRST** (из-за п. 4).

4. **major** — фрейминг в `generateQuery.ts:3` («Always return json… Do not include any additional text or explanations») противоречит tool-call контракту `createQuery` в том же system prompt, хотя спека прямо обещала «tool contracts untouched». Спекулятивно по степени влияния (зависит от модели), но конфликт прямой.
1. minor — арифметика «26 файлов»: портировано 25 `.ts`-промптов; счёт сходится только если считать извлечённый `assets/layoutExample.json` (не файл EE-библиотеки) одним из 26. Стоит сверить с `ee-extract`/планом.
3. minor — в `nest-cli.json` переформатированы два существующих ассет-энтри (однострочные → многострочные) без функциональных изменений — несвязанный шум в коммите порта.
5. minor — тот же устаревший README-ряд про `generateLayout`, что и в Standards (п. 1).

## Итог

- **Standards**: 7 находок; худшая — README противоречит уже сделанному переносу `layoutExample` (п. 1).
- **Spec**: 4 находки; худшая — JSON-фрейминг `generateQuery` конфликтует с tool-контрактом `createQuery` (п. 4, major).

Явные пересечения находок между осями (README про `generateLayout`; JSON-фрейминг `generateQuery`) — по методике не ранжируются, но фактически это одни и те же два фикса.

**Рекомендованные действия:**

1. Исправить устаревшую строку README про `generateLayout` (обе оси).
2. A/B-проверить `CREATE_QUERY_SYSTEM_PROMPT` с прифреймленным «Always return json» против tool-call контракта `createQuery`; при деградации — ослабить/убрать фрейминг (обе оси, major).
3. При врезании `dataSourcePrompts.ts` — исправить `undefined`-фоллбек, `==` и битые JSON-примеры.
