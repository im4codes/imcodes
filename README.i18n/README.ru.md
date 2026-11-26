# [IM.codes](https://im.codes)

[English](../README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [Español](README.es.md) | [Русский](README.ru.md) | [日本語](README.ja.md) | [한국어](README.ko.md)

**Self-hosted AI Force workbench с доступным исходным кодом и без vendor lock-in: кросс-вендорные Task Pairs и Execution Pool, управляемые узлы за NAT и Computer Use, встроенный 4K Remote Desktop, Cloud Docs + ONLYOFFICE и командный доступ.**

> Хватит общаться с одним ИИ. Командуйте AI Force.<br>
> Один workbench — каждая модель и каждая машина под вашим управлением.<br>
> — IM.codes

IM.codes объединяет ваших ИИ-агентов, удалённые компьютеры и документацию команды в одном workbench реального времени. **Self-hosted, с доступным исходным кодом ([BSL 1.1](../LICENSE) — бесплатно для личного использования и малых команд `<= 5` пользователей и `<= 50` человек), и без vendor lock-in** — память, код, документы и инструменты остаются в вашей инфраструктуре, а любую модель или провайдера ([Claude Code](https://github.com/anthropics/claude-code), [Codex](https://github.com/openai/codex), Antigravity CLI, [OpenClaw](https://openclaw.com), [Qwen](https://github.com/QwenLM/qwen-agent), GitHub Copilot, Cursor, OpenCode и др.) можно свободно заменить в любой момент.

> Это перевод. **Каноническая версия — английский README (`../README.md`).** Если есть расхождения, ориентируйтесь на английский вариант.

## Ключевые опоры

| Опора | Что даёт |
|---|---|
| **Task Pairs и Execution Pool (`Pair`)** | Флагманский Brain декомпозирует задачи на зависимые Brief и чеклисты, запуская изолированные пары `Executor × Auditor` в нативном Split View, закрывая слепые зоны одной модели , распределяя нагрузку между провайдерами и переключаясь по настройкам Execution Pool при лимитах со сходимостью `PASS` / `REWORK`. |
| **Управляемые узлы и AI Computer Use (`OCU`)** | Превращает машины Linux, Windows и macOS за NAT в управляемые ИИ-узлы без белого IP, VPN и проброса портов. Ограниченный `exec_remote`, прямая/relay передача файлов и GUI/CDP-автоматизация через `computer_use_call` (`^^(nodeId)`). |
| **Встроенный 4K Remote Desktop** | Встроен прямо в IM.codes без отдельной платы за удалённый рабочий стол в рамках вашей лицензии IM.codes. Подключайтесь к рабочим столам Windows, macOS и Linux из браузера или телефона в 4K, следите за 4 машинами на Стене экранов и сохраняйте контроль человека. |
| **Cloud Docs и совместное редактирование (`ONLYOFFICE`)** | Встроенные Cloud Docs + ONLYOFFICE + DocBuilder. Храните спеки, runbooks и AI Skills, вставляйте любой документ через `&` в чат и совместно создавайте, конвертируйте и редактируйте DOCX/XLSX/PPTX/Markdown. |
| **Командный доступ и контроль прав** | Делитесь Управляемыми узлами, живыми сессиями/под-сессиями и Cloud Docs по пользователям или группам (`viewer` или `participant`) с отзывом в один клик; приватные группы изолируют личные и домашние машины. |
| **3 экрана и iPhone Duo** | Бесшовная синхронизация между десктопом, планшетом, **iPhone Duo / складными экранами**, смартфоном и Apple Watch. |

## Скриншоты

### Десктоп

<p>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-sidebar.png"><img src="../landing/imcodes-sidebar.png" width="24%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes0.png"><img src="../landing/imcodes0.png" width="24%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes1.png"><img src="../landing/imcodes1.png" width="24%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes2.png"><img src="../landing/imcodes2.png" width="24%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-nodes.png"><img src="../landing/imcodes-nodes.png" width="24%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-clouddocs.png"><img src="../landing/imcodes-clouddocs.png" width="24%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes3.png"><img src="../landing/imcodes3.png" width="24%" /></a>
</p>

### iPad / Планшет

<p>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-ipad2.png"><img src="../landing/imcodes-ipad2.png" width="48%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-ipad3.png"><img src="../landing/imcodes-ipad3.png" width="48%" /></a>
</p>

### iPhone Duo / Складной экран

<p>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-duo1.png"><img src="../landing/imcodes-duo1.png" width="48%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-duo2.png"><img src="../landing/imcodes-duo2.png" width="48%" /></a>
</p>

### Мобильный

<p>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m0.png"><img src="../landing/imcodes-m0.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m1.png"><img src="../landing/imcodes-m1.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m2.png"><img src="../landing/imcodes-m2.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m3.png"><img src="../landing/imcodes-m3.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m4.png"><img src="../landing/imcodes-m4.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m5.png"><img src="../landing/imcodes-m5.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m6.png"><img src="../landing/imcodes-m6.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m7.png"><img src="../landing/imcodes-m7.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m8.png"><img src="../landing/imcodes-m8.png" width="18%" /></a>
</p>

### Apple Watch

<p>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-watch1.png"><img src="../landing/imcodes-watch1.png" width="31%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-watch0.png"><img src="../landing/imcodes-watch0.png" width="31%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-watch2.png"><img src="../landing/imcodes-watch2.png" width="31%" /></a>
</p>

Поддержка часов включает быстрый просмотр сессий, счётчики непрочитанных сообщений, push-уведомления и быстрые ответы с запястья.

## Task Pairs и кросс-вендорный Execution Pool

Управляйте несколькими моделями ИИ как дисциплинированной инженерной командой, а не одним чатом с одной моделью.

- **Декомпозиция Brain и зависимости.** Флагманский Brain разбивает цели на зависимые Brief и нумерованные чеклисты (`pair_create`, `pair_task_update`) в изолированных worktree или рабочих директориях.
- **Кросс-вендорный Execution Pool.** Комбинируйте флагманские и вторичные модели Claude Code, Codex, Antigravity CLI, Qwen и других, закрывая слепые зоны , распределяя нагрузку между провайдерами и переключаясь по настройкам Execution Pool при срабатывании лимитов.
- **Нативный Split View (`Executor × Auditor`).** Реализация и независимый аудит рядом в реальном времени со структурированной сходимостью `PASS` / `REWORK`.
- **Global Task Mode без vendor lock-in.** Оркестрируйте многоэтапные процессы на любых серверах и меняйте провайдеров когда угодно.

## Управляемые узлы и встроенный 4K Remote Desktop

Машины Linux, Windows и macOS за NAT превращаются в узлы для ИИ и удалённые рабочие столы без белого IP, VPN и проброса портов.

- **Одна AI Force — парк машин.** Введите `^` (или `^^(nodeId)`), чтобы выполнять `exec_remote`, передавать файлы или автоматизировать GUI и CDP-браузер через `computer_use_call` и [Open Computer Use](https://github.com/iFurySt/open-codex-computer-use) (Leo, MIT).
- **Встроенный 4K Remote Desktop.** Работайте с Windows, macOS и Linux из браузера или телефона (сенсорная навигация, виртуальная мышь).
- **Стена из 4 экранов.** Наблюдайте до 4 хостов одновременно, сохраняя полный человеческий контроль.
- **Независимые учётные данные и отзыв в один клик.**

## Cloud Docs и совместное редактирование

Встроенные Cloud Docs (ONLYOFFICE + DocBuilder) держат спецификации, runbooks и AI Skills рядом с кодом: вставляйте документы в чат через `&` или управляйте ими через MCP-инструмент `cloud_docs` (DOCX/XLSX/PPTX/Markdown).

## Командный доступ и совместные пространства

Делитесь Управляемыми узлами, живыми сессиями, под-сессиями и Cloud Docs с ролями `viewer` и `participant`, отзывайте доступ в один клик и изолируйте домашние машины через приватные группы.

## Загрузка

<a href="https://apps.apple.com/us/app/im-codes/id6761014424"><img src="https://developer.apple.com/assets/elements/badges/download-on-the-app-store.svg" height="40" alt="Download on the App Store" /></a>

Поддерживаются iPhone, iPad и Apple Watch. Также доступно как [web app](https://app.im.codes).

## Зачем

Когда вы отходите от рабочего места, большинство workflows с coding agents ломается. Агент всё ещё работает в терминале, но продолжение требует SSH, `tmux attach`, удалённого рабочего стола или ожидания возвращения к ноутбуку.

Эта проблема доступа — только половина истории. Сложная работа с coding agents также требует более устойчивого суждения: одна модель может застрять в привычных шаблонах, пропустить проблемы или дать нестабильный ответ на трудной задаче. Смена provider даёт новую перспективу, но без общего контекста легко потерять нить.

[IM.codes](https://im.codes) закрывает обе потребности. Он удерживает эти сессии доступными с телефона или из веба: открыть терминал, проверить файлы и Git, посмотреть localhost с другого устройства, получить уведомление о завершении работы, пригласить другого человека в ту же session или server и координировать несколько агентов на собственной инфраструктуре. Он также связывает "Shared Agent Context и память" с "Кросс-модельный аудит и Team обсуждения": долговременный recall приходит из сводок завершённой работы, а Team обсуждение — это структурированный кросс-модельный review до попадания кода. Это не делает вывод идеальным, но уменьшает слепые зоны одной модели и помогает сложной работе сходиться под большим числом проверок.

Это не ещё один AI IDE и не просто удалённый терминал. Это слой сообщений, памяти и review вокруг терминальных coding agents.

## OpenSpec Auto Deliver

Для OpenSpec-based changes Auto Deliver превращает change folder в end-to-end supervised delivery run: proposal/spec review, implementation, validation, Team audit, автоматическая оценка модулей, rework gates и видимый final handoff.

- **One-click change pipeline.** Запускается из transport-backed coding session. IM.codes определяет owning session, блокирует Team lane от конфликтующих runs, читает `tasks.md` и показывает live run projection в UI.
- **Spec audit до implementation.** Опциональный proposal/spec audit-repair использует обычный Team flow (по умолчанию `audit>review>plan`) и читает authoritative JSON вместо доверия chat summaries.
- **Task-driven implementation loop.** Daemon отправляет focused implementation prompts в ту же session, работает только с этим OpenSpec change, отслеживает checked/unchecked tasks и показывает безопасные validation command candidates из project manifests.
- **Автоматическая оценка модулей.** Каждый audit выдаёт structured scores для `spec`, `tasks`, `implementation`, `tests` и `risk`; evidence и summaries видны в run details, а не спрятаны в chat text.
- **Implementation audit и rework gates.** Финальный scored verdict — `PASS`, `REWORK` или `BLOCKED` — решает, пройдет ли run, будет ли repair в пределах лимитов или нужна human decision.
- **Fail-closed и контроль человека.** Auto Deliver просит human input при invalid audit output, исчерпанных time/prompt limits, manual interference, несовместимом Team state или unreadable tasks. Он не делает stage, commit или push кода.

## Совместное программирование

Поделитесь текущей вкладкой, sub-session или всем source server с другим пользователем. `viewer` подходит для read-only review, `participant` — когда teammate должен отправлять prompts в покрытые sessions. Shared messages несут actor labels, а доступ можно понизить или отозвать из UI.

## Shared Agent Context и память

IM.codes постоянно превращает уже завершённую работу агентов в переиспользуемую память и возвращает этот контекст в будущие сессии.

- **Сохраняется связка проблема → решение, а не шум логов.** В память попадают только финальные `assistant.text`; стриминговые delta, tool call, tool result и промежуточный шум исключаются.
- **Личная память с опциональной облачной синхронизацией.** Сырые и обработанные данные всегда остаются локально; обработанные сводки можно по желанию синхронизировать в пользовательский облачный пул, общий для всех ваших устройств.
- **Enterprise Shared Context доступен для поиска и просмотра.** Команды могут публиковать переиспользуемую память в пределах workspace/project, просматривать её в UI, искать и анализировать статистику, а не держать контекст скрытым внутри prompt'ов. Эта часть всё ещё активно разрабатывается и ещё не прошла полноценное продакшен-тестирование.
- **Многоязычный recall.** Локальный семантический поиск и серверный recall на pgvector используют многоязычные embeddings, поэтому связанные решения находятся между английским, китайским, японским, корейским, испанским, русским и смешанными репозиториями.
- **Автоматическая инъекция там, где это важно.** Релевантная история автоматически подмешивается как при отправке сообщения, так и при старте сессии, а карточки timeline показывают, что именно было найдено, почему, score релевантности, число recall и время последнего использования.
- **Пользователь видит и контролирует процесс.** UI Shared Context разделяет raw events, processed summaries, cloud memory и enterprise memory и даёт управление поиском, preview, archive/restore и настройками обработки.

## Управляемые MCP-инструменты

IM.codes открывает поддерживаемым SDK-провайдерам stdio MCP server, управляемый daemon. Агенты получают единую runtime-scoped поверхность инструментов для памяти, agent-to-agent сообщений и запланированных follow-up без сырых auth tokens и ad hoc shell-команд.

- **Поиск памяти и provenance.** `search_memory` ищет в memory namespace, привязанном к вызывающему агенту: прошлую работу, историю проекта, решения, preferences, bugs, commits, deployments и ранее обсуждённый контекст. `list_memory_summaries` получает recent compact summaries без запроса. Результаты содержат compact refs и `projectionId`; `get_memory_sources` разворачивает релевантный hit в source snippets, когда модели нужны точные прошлые инструкции, детали bug, commit/deployment context или source evidence.
- **Запись памяти.** `save_observation` сохраняет полезные факты, решения или заметки реализации как user-private memory candidates; `save_preference` сохраняет стабильные пользовательские preferences через явный preference path.
- **Agent messaging.** `send_list_targets` перечисляет sibling sessions текущего проекта, а `send_message` отправляет scoped messages, optional file path references, reply requests или broadcasts через тот же защищённый pipeline `imcodes send`.
- **Cron scheduling.** `cron_create`, `cron_list`, `cron_update` и `cron_delete` управляют future structured sends для reminders, recurring checks, delegated reviews или scheduled Team follow-ups, включая target/session/project fields и optional expiration/timezone data.
- **Runtime-bound identity и безопасность.** Tool calls на runtime привязаны к текущим IM.codes session, project, user и server. Агенты не могут подделать namespace, user, server, token или routing fields; Memory, Send и Cron остаются за underlying feature gates и MCP kill-switches.
- **Операционная видимость.** UI Shared Context показывает MCP readiness по managed provider, состояние tool-family gates, degraded reasons, update time и последние daemon-redacted tool calls, чтобы было понятно, действительно ли модель имеет доступ к Memory, Send и Cron.

## Контролируемое выполнение и Auto Audit

IM.codes может вести поддерживаемые agent session ход за ходом с помощью вашего собственного supervisor-промпта — на каждой idle-границе структурно оценивается завершённый ход и принимается решение auto-continue, вернуть управление или запустить audit-цикл, вместо того чтобы вы вручную набирали "continue" каждый раунд.

- **Режимы Auto на уровне session.** Можно настраивать `off`, `supervised` и `supervised_audit` для каждой session отдельно, не навязывая одну политику всем.
- **Проверка завершения на границе idle.** Когда ход заканчивается, IM.codes может классифицировать его как `complete`, `continue` или `ask_human` и отправить следующий continue prompt в ту же session.
- **Fail-closed автоматизация.** Auto supervision остаётся видимым в timeline/footer, использует структурированные решения и возвращает управление пользователю при timeout, невалидном выводе или плохой конфигурации вместо догадок.
- **Опциональный цикл audit → rework.** В `supervised_audit` завершённый ход может автоматически перейти в аудит, а brief на доработку вернётся в ту же session до возврата управления.
- **Глобальные значения по умолчанию + переопределение на уровне session.** Один раз задайте default backend/model/timeout для supervisor, а при необходимости переопределяйте backend/model/timeout, режим audit и пользовательские инструкции для конкретной session.
- **Понимание реальных workflow IM.codes.** Auto supervision понимает OpenSpec-задачи, Team review/discussion и координацию через `imcodes send` как нормальные следующие действия агента, а не как повод немедленно остановиться и ждать человека.

## Возможности

### Приватные алиасы

Сохраняйте принадлежащие пользователю переиспользуемые фрагменты текста и находите их, набрав `;` в composer, либо вставляйте маркер `;;(name)` напрямую. В сообщении маркер остаётся видимым, а IM.codes разрешает и передаёт значение агенту вне основного текста. Агенты также могут создавать, искать, редактировать и разрешать алиасы через управляемые MCP tools; массовый список раскрывает только метаданные, поэтому один вызов не выгружает все значения в контекст модели.

### Управляемые узлы

Зарегистрируйте один или несколько компьютеров, наберите `^` для выбора цели (или вставьте `^^(name)`), и авторизованные агенты смогут работать на выбранной машине. Они выполняют команды с ограниченной областью, передают отдельные файлы и используют типизированный Computer Use — так одним диалогом можно управлять и координировать целый парк. Выполнение остаётся под контролем владельца и может быть отозвано; каждый узел получает независимые учётные данные и не попадает в обычные списки server/session. Ссылки на скачивание истекают, но установщик можно сохранить и использовать повторно.

### Удалённое управление рабочим столом

Совместимые Windows-узлы предоставляют авторизованным владельцам и участникам удалённый рабочий стол прямо в браузере. Можно переключаться между управлением и просмотром, выбирать дисплей и качество, а также подключать нескольких авторизованных зрителей или операторов. На телефоне сенсорная навигация и виртуальная мышь позволяют полноценно управлять рабочим столом.

Удалённый рабочий стол автоматически выбирает доступное соединение, а доступ можно отозвать в любой момент. **Сейчас удалённый рабочий стол доступен на Windows; узлы macOS и Linux сохраняют остальные возможности, поддержка рабочего стола планируется.**

### Computer Use и автоматизация браузера

Поддерживаемые SDK-агенты могут управлять desktop-приложениями через типизированные Computer Use tools. Кроссплатформенный путь управления desktop-приложениями интегрирует [Open Computer Use](https://github.com/iFurySt/open-codex-computer-use) от Leo ([iFurySt](https://github.com/iFurySt)), распространяемый по лицензии MIT; этому проекту явно выражается благодарность за интегрированную возможность.

Автоматизация браузера — отдельная функция IM.codes, реализованная напрямую поверх Chrome DevTools Protocol (CDP). Она позволяет открывать, инспектировать и навигировать страницы, нажимать элементы, заполнять поля и выполнять скрипты; по умолчанию возвращается структурированный текст, а снимок экрана добавляется только по запросу. Управляемый браузер также публикует CDP endpoint только на loopback, чтобы локальные Python- или Node-скрипты могли повторно использовать тот же запущенный экземпляр.

### Удалённый терминал
Полный доступ к терминалу agent‑сессий из любого браузера без SSH, VPN и проброса портов.

### Браузер файлов и Git changes
Просмотр дерева проекта, загрузка и скачивание файлов, diff‑просмотр, обзор изменений и безопасный быстрый HTML‑превью. Локальные ссылки на изображения в чате также показываются inline и открываются в увеличенном плавающем просмотре.

### Локальный web preview
Без деплоя можно открыть локальный dev‑сервер на телефоне, планшете или в удалённом браузере.

### Мобильные устройства, часы и уведомления
Есть биометрическая аутентификация, push‑уведомления, ввод для shell‑сессий и быстрые ответы на Apple Watch.

### OpenSpec Auto Deliver
Проведите spec-driven change через structured pipeline: proposal/spec audit, implementation prompts, manifest-aware validation hints, Team audit/rework, автоматическая оценка spec/tasks/implementation/tests/risk и fail-closed handoff.

### Совместное программирование
Поделитесь live session для pair programming или пригласите нескольких людей в scoped server workspace с ролями viewer/participant.

### Кросс-модельный аудит и Team обсуждения
Выходу одной модели нельзя доверять слепо. Team обсуждения позволяют нескольким агентам — от разных провайдеров и с разными стилями мышления — совместно анализировать одну кодовую базу ещё до написания кода. Каждый раунд следует настраиваемому многоэтапному пайплайну, где каждый агент читает все предыдущие вклады. Разные модели находят разные типы проблем. Такая перекрёстная проверка ещё до реализации выявляет проблемы, которые одна модель часто пропускает, и сокращает переделки.

Встроенные режимы: `audit` (структурированный пайплайн audit → review → plan), `review`, `discuss` и `brainstorm` — или определите собственную последовательность фаз. Работает с Claude Code, Codex, Antigravity CLI и Qwen.

### Потоковые transport‑агенты
OpenClaw и Qwen работают через структурированный transport‑stream вместо terminal scraping.

### Управляемая MCP-поверхность
Поддерживаемые SDK-провайдеры могут автоматически получать управляемую IM.codes MCP-поверхность из десяти инструментов: memory search/source lookup, observation/preference capture, scoped Send и Cron scheduling. UI сообщает ready/degraded состояния по provider, чтобы было понятно, доступны ли Memory, Send и Cron конкретной модели.

### Связь агент ↔ агент
`imcodes send` позволяет одному агенту напрямую просить другого проверить код, запустить тесты или продолжить задачу.

Тот же flow доступен SDK-агентам через MCP: `send_list_targets` находит допустимые sibling targets, а `send_message` отправляет scoped text, file references, reply requests или broadcasts без раскрытия raw routing credentials.

```bash
imcodes send "Plan" "review the changes in src/api.ts"
imcodes send "Cx" "run tests" --reply
imcodes send --all "migration complete, check your end"
```

```python
# monitor.py — watch a log file, trigger agent when errors appear
import subprocess, time

while True:
    with open("/var/log/app.log") as f:
        for line in f:
            if "ERROR" in line:
                subprocess.run([
                    "imcodes", "send", "Claude",
                    f"Fix this error and write the patch to /tmp/fix.patch:\n{line}"
                ])
    time.sleep(30)
```

```bash
# Webhook → agent: GitHub webhook handler triggers code review
curl -X POST https://your-server/webhook -d '{"pr": 42}' \
  && imcodes send "Gemini" "review PR #42, write summary to /tmp/review.md"

# CI → agent: post-build trigger
imcodes send "Claude" "tests failed on main, check CI log at /tmp/ci.log and fix" --reply
```

### Умный picker `@`
`@` ищет файлы проекта, `@@` выбирает агентов для Team dispatch.

### Управление несколькими серверами и сессиями
Можно подключить несколько dev‑машин к одной панели.

### Боковая панель в стиле Discord
Есть панель серверов, древовидный список сессий, unread badges и закрепляемые окна.

### Закрепляемые панели
Файловый браузер, страница репозитория, чат sub‑session и терминал можно закрепить в боковой панели.

### Дашборд репозитория
В приложении можно просматривать issues, PR, branches, commits и CI/CD runs.

### Планировщик задач (Cron)
Поддерживаются cron‑задачи для запуска команд и multi‑agent дискуссий.

SDK-агенты могут управлять тем же scheduler через MCP с помощью `cron_create`, `cron_list`, `cron_update` и `cron_delete`, создавая structured sends для reminders, recurring checks, delegated reviews или follow-ups, оставаясь привязанными к текущей project/session identity.

### Синхронизация между устройствами
Порядок вкладок и закреплённые панели синхронизируются через серверные preferences.

### Интернационализация
Интерфейс поддерживает 7 языков.

### OTA‑обновления
Daemon может обновляться через npm, в том числе по команде из веб‑интерфейса.

## Чем IM.codes не является

- Это не ещё один AI IDE
- Это не просто чат‑обёртка
- Это не просто клиент удалённого терминала
- Это не замена Claude Code, Codex, Antigravity CLI, OpenClaw или Qwen
- Это слой управления и обмена сообщениями вокруг них

## Архитектура

```
You (browser / mobile)
        ↓ WebSocket
Server (self-hosted)
        ↓ WebSocket
Daemon (your machine)
        ↓ tmux / transport / managed MCP
AI Agents (Claude Code / Codex / Antigravity CLI / OpenClaw)
        ↔ imcodes send (agent-to-agent)
```

Daemon работает на вашей dev‑машине и управляет process-backed сессиями через tmux, а transport-backed сессиями через SDK и сетевые протоколы. Он также владеет managed MCP server, который открывает runtime-scoped Memory, Send и Cron tools поддерживаемым SDK-провайдерам. Сервер проксирует соединения между вашими устройствами и daemon. Всё остаётся на вашей инфраструктуре.

## Установка

```bash
curl -fsSL https://im.codes/install.sh | bash
# fallback: npm install -g imcodes
```

## Быстрый старт

> **Self-hosting настоятельно рекомендуется.** Общий инстанс `app.im.codes` предназначен только для тестирования.

```bash
imcodes bind https://app.im.codes/bind/<api-key>
```

Эта команда привязывает вашу машину, запускает daemon, регистрирует его как системный сервис и добавляет машину в веб / мобильную панель.

### Подключение OpenClaw

Если OpenClaw запущен локально, подключите IM.codes к OpenClaw gateway на машине с daemon:

```bash
imcodes connect openclaw
```

Команда:

- подключается по умолчанию к `ws://127.0.0.1:18789`
- автоматически использует token из `~/.openclaw/openclaw.json`
- синхронизирует основные и дочерние сессии OpenClaw в IM.codes
- сохраняет конфигурацию в `~/.imcodes/openclaw.json`
- перезапускает daemon для автоматического восстановления transport‑сессий

```bash
imcodes connect openclaw --url ws://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=... imcodes connect openclaw
imcodes connect openclaw --url wss://gateway.example.com
```

Примечания:

- для удалённых `ws://` без TLS нужен `--insecure`
- `imcodes disconnect openclaw` удаляет сохранённую конфигурацию и разрывает соединение
- этот сценарий пока тестировался только на macOS

## Self-host

### Настройка одной командой

```bash
curl -fsSL https://im.codes/install.sh | bash   # fallback: npm install -g imcodes
mkdir imcodes && cd imcodes
imcodes setup --domain imc.example.com
```

### Ручная настройка

```bash
git clone https://github.com/im4codes/imcodes.git && cd imcodes
./gen-env.sh imc.example.com        # generates .env with random secrets, prints admin password
docker compose up -d
```

Сгенерированный `docker-compose.yml` уже использует `pgvector/pgvector:pg18` для PostgreSQL.

## Windows (экспериментально)

```powershell
irm https://im.codes/install.ps1 | iex
# fallback: npm install -g imcodes
imcodes bind https://app.im.codes/bind/<api-key>
```

```cmd
imcodes upgrade
```

```cmd
imcodes repair-watchdog
```

```cmd
npm prefix -g
```

```cmd
setx PATH "<npm-prefix-path>;%PATH%"
```

```
%USERPROFILE%\.imcodes\watchdog.log
```

## Требования

- macOS или Linux
- Windows (экспериментально) через ConPTY
- Node.js >= 22
- tmux на Linux/macOS
- как минимум один AI coding agent: Claude Code, Codex, Antigravity CLI, OpenClaw или Qwen

## О проекте

Это личный проект. Я почти не писал код сам: он почти полностью создан [Claude Code](https://github.com/anthropics/claude-code), со значительным вкладом [Codex](https://github.com/openai/codex) и Antigravity CLI.

## Дисклеймер

IM.codes — независимый проект с доступным исходным кодом (source-available) и не аффилирован с Anthropic, OpenAI, Google, Alibaba, OpenClaw или другими упомянутыми компаниями.

## Лицензия

[Business Source License 1.1 (BSL 1.1)](../LICENSE) — [Коммерческое лицензирование](../COMMERCIAL-LICENSE.md) | [Уведомления о сторонних компонентах](../THIRD_PARTY_NOTICES.md)

- **Непродуктивное и личное продуктивное использование:** Непродуктивное использование (оценка, тестирование, разработка), копирование, модификация и соблюдающее лицензию распространение с сохранением уведомлений об авторском праве и товарных знаках бесплатны для организаций любого размера по BSL 1.1; личное использование физическими лицами для личной разработки, обучения, исследований или личного self-hosting на своих устройствах/серверах (без централизованного развёртывания/совместного использования в организации и без оказания коммерческих услуг хостинга/SaaS/white-label третьим лицам) бессрочно бесплатно независимо от размера работодателя.
- **Малые команды (внутренний production):** Бесплатно по дополнительному разрешению только при одновременном соблюдении **обоих** лимитов **в сумме по юридическому лицу, аффилированным компаниям и всем развёрнутым инстансам**: **<= 5** активных пользователей **и** общая численность организации **<= 50** человек.
- **Вне дополнительного разрешения (коммерческая лицензия):** До даты перехода внутреннее использование в production сверх любого из порогов (например, `6/50` или `5/51`), а также использование в production для коммерческого хостинга, managed-услуг, multi-tenant SaaS или white-label перепродажи (даже для 1 человека) исключены из дополнительного разрешения и требуют коммерческой лицензии (`support@im.codes`).
- **Дата перехода:** Переходит под [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0) через 4 года после публикации каждой версии (`2030-11-26` для данного релиза).

© 2026 [IM.codes](https://im.codes)
