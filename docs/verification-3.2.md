# Приёмка отложенных операций Unica

Дата проверки: 2026-11-25. Проверка выполнена в локальном пакете `bb-plugin-unica` на Windows x64, Node.js 24.4.1, Plugin SDK 0.6.157.

## Проверено локально

Без shim тестовый процесс `tsx` завершился до запуска тестов с системной ошибкой `uv_os_get_passwd returned ENOMEM` в `os.userInfo()`. Повторный запуск `npm run check` с одноразовым Node preload в `%TEMP%` прошёл; shim подменял только `os.userInfo()` на время процесса и после запуска был удалён. Команда запуска тестов внутри npm script:

```powershell
node --require $shim --import tsx --test tests/*.test.ts
```

Результат: 7 тестов пройдены; `tsc --noEmit` тоже завершился успешно.

Сборка `node <локальная-копия-bb>/dist/bb.js plugin build .` завершилась успешно. Для неё использовалась локальная копия BB 0.50.1 из `%TEMP%`, `BB_CLI` установленного приложения был удалён из процесса, а `BB_CLI_REEXEC=1` отключил повторный запуск запрещённого installed CLI. Сборка выпустила `dist/server.js`, `dist/server.js.map`, `dist/server.meta.json`, `dist/app.js`, `dist/app.css`, `dist/app.meta.json`, `dist/host.js`, `dist/host.js.map`, `dist/host.meta.json`.

Проверки фикстур подтверждают:

- два независимых пути worktree и чтение настроек политики из основного источника;
- отказ при неготовом окружении без перехода на основной источник;
- отдельное подтверждение для `unica.apply`, привязанное к пути и команде; смена окружения до подтверждения блокирует исполнение;
- политика `read` запрещает запись до вызова host executor;
- миграция политики и сохранение пользовательских навыков.

## Живой runtime

Для проверки использован отдельный Git-репозиторий с синтетической конфигурацией и модулем Probe. Исходники лежат в `src`, в `v8project.yaml` задано `main: CONFIGURATION`. Инфобаза не настроена. Для синхронных вызовов использовался ранее подготовленный официальный рантайм Unica 0.16.0.

На отдельном сервере BB 0.50.1 локальная установка завершилась успешно. `unica-bootstrap run --plugin-root <Unica 0.16.0>` прошёл MCP initialize: `serverInfo={name:"unica",version:"0.16.0"}`, protocol `2025-06-18`; `tools/list` вернул 11 инструментов, включая `unica.task.get`, `unica.task.result` и `unica.task.cancel`.

Реальные ответы безопасных вызовов:

- `unica.run {}` вернул `ok:true`, `summary:"canonical run operation dictionary returned"` и список операций адаптера v8-runner 0.18.1. В словаре `make`, `source.reexport` и операции с инфобазой помечены `execution:"previewApply"` и `dryRunRequired:true`; инфобаза не сконфигурирована, эти операции не исполнялись.
- `unica.view {}` распознал `main` как `platform_xml`, `sourceState:"supported"`, `effectiveSourceRoot` указывает на синтетический source root.
- `unica.check {}` завершился с `summary:"workspace is ready"`, `status:"passed"`, `ready:true`, `readinessState:"complete"`. Отчёт сохранил отдельные repository-диагностики о недостающих `.gitignore` и `.gitattributes` правилах; это не изменяло исходники.
- `unica.docs` с запросом о фоновых заданиях вернул `summary:"unica.docs completed"` и результаты из `platform-syntax-help` и `v8std`.

Ни один из этих ответов не содержал `data.task` или `taskId`; `unica.task.result` поэтому не вызывался. Это подтверждает синхронное завершение выбранных безопасных операций, но не отсутствие deferred-задач у других операций. Для получения `taskId` пришлось бы выбрать более длительную работу; доступные операции `unica.run`, способные менять файл или инфобазу, требуют отдельного исполнения и потому здесь не запускались.

Первый прямой запуск из `%TEMP%` завершался `Access denied` при открытии provider-state и source root. После переноса только временного provider-state и синтетического source root под каталог пакета MCP успешно стартовал и прочитал исходники. Живой профиль и рабочие базы не затрагивались.

## Отложенный вызов через установленный `bb-unica`

В рабочем профиле BB вызовы прошли через `unica_call` плагина `bb-unica` 0.1.0 с Unica 0.16.0. Цель — синтетический проект с набором исходников `main`, без настроенной информационной базы. Для проверки использовался предварительный просмотр `unica.run` с операцией `make`, `dryRun: true` и `waitMs: 0` на стороне моста.

| Вызов | Наблюдаемый результат |
| --- | --- |
| `unica.run make` до настройки `v8project.yaml` | `taskId` `8df9e2ad-6734-4697-a542-f002cec08801`, исходный статус `working`. |
| `unica.task.result` по первому ID | `ok: false`, диагностика `invalid_state`: отсутствует `v8project.yaml`. |
| `unica.run make` после добавления предложенного `unica.view` временного конфига | `taskId` `bb58fb68-56b4-47de-82da-2be23194cdc5`, исходный статус `working`. |
| `unica.task.result` по второму ID | `ok: true`, план сборки `main` в `.bsl-flow/evidence/unica-deferred-acceptance.cf`: `dryRun: true`, `providerDispatched: false`, `outputExists: false`. |
| `unica.task.get` по второму ID | Терминальный статус `completed`. |

Подтверждён полный цикл отложенного предварительного просмотра: выдача ID, получение результата и терминального статуса через тот же плагин и в том же проекте. Сборка `.cf` и изменение инфобазы в этот сценарий не входили. Файл `.cf` отсутствует.

Этим прогоном подтверждён пункт 3.2.
