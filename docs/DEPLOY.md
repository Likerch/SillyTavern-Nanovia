# Установка, стенд и деплой Nanovia

Nanovia состоит из двух частей (подробнее в `docs/ARCHITECTURE.md`):

| Часть                                         | Что это                                                                       | Обязательна?                                        |
| --------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------- |
| **Расширение** (`manifest.json`, `dist/`)     | панель, синхронизация подключений с профилями Connection Manager, `NANOVIA_API` | да                                                  |
| **Серверный плагин** (`server/index.js`)      | локальный OpenAI-совместимый прокси к NanoGPT, учёт расхода, ключ из секретов ST | нет, но без него работает только прямой режим (`direct`) |

Требования: Node 20.19+, SillyTavern 1.19.x. Собранные `dist/` и `server/index.js` лежат в репозитории, на сервере сборка не нужна.

Все команды ниже выполняются из корня репозитория.

---

## 1. Мок NanoGPT

Заменяет `https://nano-gpt.com` в тестах и на стенде: каталог (снимок настоящего), провайдеры моделей, чат со стримингом, usage и стоимость, баланс, подписка, Management API, заглушки картинок. Без зависимостей.

```bash
npm run mock                                # http://127.0.0.1:5300/api/v1   (MOCK_PORT или --port)
node tools/mock-nanogpt/server.mjs --host 0.0.0.0   # если плагин в контейнере (см. п. 3)
```

Маршруты, «магические» заголовки (`x-mock-error`, `x-mock-delay-ms` …), модели `mock/*` и формат журнала запросов (`GET /__mock/requests`, ключи в нём замаскированы) описаны в `tools/mock-nanogpt/README.md`. Любой ключ вида `sk-nano-<8+ символов>` годится; токены Management API — `sk-nano-mgmt-…`.

Данные для мока лежат в `tools/fixtures/`. Обновить снимок каталога и провайдеров (публичные адреса, ключ не нужен): `npm run fixtures:refresh` (`-- --offline` пересобирает только модели `mock/*`).

---

## 2. Локальный стенд (SillyTavern без Docker)

Стенд запускает ST 1.19 из локального дерева исходников напрямую через Node, рядом с моком NanoGPT. Всё, что он создаёт, лежит в `tools/stand/runtime/` (в git не попадает); дерево исходников ST не меняется.

```bash
npm run build          # собрать dist/ и server/index.js (без них стенд поднимется, но без расширения/плагина)
npm run stand          # первый раз сам делает setup, потом запускает мок и ST
npm run stand -- status
npm run stand -- logs st -n 100
npm run stand:stop
```

Открыть <http://127.0.0.1:8130/>. Порты: ST 8130 (`STAND_ST_PORT`), мок 5300 (`STAND_MOCK_PORT`), прокси плагина 8788 (`STAND_PROXY_PORT`; у боевого плагина по умолчанию 8787, стенд выбирает другой, чтобы не мешать).

Что делает `setup` (`npm run stand -- setup [--force] [--copy]`):

- берёт дерево ST из `STAND_ST_DIR`, по умолчанию `st-local-docker/src-1.19.0` рядом с репозиторием или выше (поиск идёт по родительским папкам, поэтому работает и из git worktree). В дереве должны быть `node_modules`; стенд их не ставит;
- собирает «серверную папку» стенда `runtime/st`: `src/` копируется (ST считает свои пути от реального пути `src/server-directory.js`, ссылка увела бы его `plugins/` в общее дерево), `node_modules`, `public`, `default` подключаются ссылками (junction на Windows);
- пишет `runtime/config/config.yaml` из `default/config.yaml`: порт 8130, `listen: false`, белый список, без basic auth, **`enableServerPlugins: true`**, без автообновлений расширений и плагинов;
- создаёт пользователя в `runtime/data/default-user`: `settings.json` (Chat Completion → Custom → мок, чтобы цепочка ST → мок работала сразу) и `secrets.json` с фальшивым ключом NanoGPT (`api_key_nanogpt`) и ключом для Custom. Существующие файлы не трогаются, `--force` перезаписывает;
- ставит расширение: папка с копией `manifest.json` и ссылкой `dist` на `dist/` репозитория (пересборка видна после перезагрузки страницы; `--copy` кладёт обычную копию);
- ставит плагин в `runtime/st/plugins/nanovia` (`index.js`, `package.json`) и пишет ему `config.json`: `{ "port": 8788, "upstreamBase": "http://127.0.0.1:5300/api/v1", "timeoutMs": 30000 }`.

Каждый `npm run stand` заново подхватывает сборку: перелинковывает `dist/`, копирует `server/index.js` (плагин ST грузит только при старте, после пересборки плагина нужен `npm run stand -- restart`). Если `dist/index.js` или `server/index.js` ещё нет, стенд пишет предупреждение и работает без них.

`npm run stand -- reset` удаляет данные, конфиг, логи и установленный плагин (`--all` ещё и копию дерева ST).

### Если готового дерева ST с `node_modules` нет

Стенд не ставит зависимости ST сам (это сотни мегабайт). Нужны один раз:

```bash
git clone --branch 1.19.0 --depth 1 https://github.com/SillyTavern/SillyTavern <папка>
cd <папка> && npm ci --omit=dev
# затем в репозитории Nanovia:
STAND_ST_DIR=<папка> npm run stand        # PowerShell: $env:STAND_ST_DIR = '<папка>'; npm run stand
```

Совсем вручную (без скрипта стенда): в чистой копии ST положить `config.yaml` с `enableServerPlugins: true`, выполнить `npm run deploy:local -- --st <папка ST>` (п. 3), положить в `<ST>/plugins/nanovia/config.json` `{ "port": 8788, "upstreamBase": "http://127.0.0.1:5300/api/v1" }`, запустить `npm run mock` и `node server.js` в папке ST.

---

## 3. Локальная dev-ST (st-local-docker)

Раскладка `st-local-docker`: `docker-compose.yml` монтирует `./config`, `./data`, `./plugins` (в `/home/node/app/plugins`) и `./extensions` (в `/home/node/app/public/scripts/extensions/third-party`).

```bash
npm run build
npm run deploy:local                        # расширение + плагин
npm run deploy:local -- --extension-only    # только расширение (достаточно перезагрузить страницу)
npm run deploy:local -- --server-only       # только плагин (нужен перезапуск контейнера)
```

Куда копировать, определяется по первому найденному: `--st <папка>`, переменная `NANOVIA_ST_DIR`, `.dev/deploy.json` вида `{ "stDir": "../st-local-docker" }` (файл локальный), соседняя папка `st-local-docker` (ищется и выше репозитория). Поддерживаются обычная копия ST (`public/scripts/extensions/third-party`, `plugins/`) и Docker-раскладка (`extensions/`, `plugins/`).

Что копируется: для расширения только `manifest.json` и `dist/`; для плагина только `server/index.js` и `server/package.json`. `server/config.json` и `server/data/` не копируются никогда, а `config.json` и `data/`, уже лежащие в `plugins/nanovia`, сохраняются. Если целевая папка — git-клон (есть `.git`), скрипт останавливается; `--force` заменит файлы.

Включить плагины в `config/config.yaml` (`enableServerPlugins: true`) или переменной `SILLYTAVERN_ENABLESERVERPLUGINS: "true"` в compose-файле, затем `docker compose up -d` (перезапуск).

Только плагин, без Node-скрипта: `scripts/install-server.ps1 -SillyTavern <папка ST>` (Windows) или `scripts/install-server.sh <папка ST>` (Linux/macOS/хост Docker). Оба копируют `server/index.js` и `package.json` в `<ST>/plugins/nanovia`, сохраняют `config.json` и `data/`, напоминают про `enableServerPlugins` и перезапуск.

Мок для плагина в контейнере: мок слушает `127.0.0.1` хоста, контейнер его не видит. Запустить мок с `--host 0.0.0.0` и прописать в `plugins/nanovia/config.json`: `{ "upstreamBase": "http://host.docker.internal:5300/api/v1" }` (на Linux добавить в compose `extra_hosts: ["host.docker.internal:host-gateway"]`). Проще всего для проверки связки пользоваться стендом из п. 2.

---

## 4. Боевой сервер (ST в Docker)

Порядок, который уже отработан на остальных расширениях: клон репозитория в папку расширений, плагин копируется в папку плагинов, перезапуск контейнера.

**Перед обновлением:**

1. Сделать копию `settings.json` пользователя (в нём лежат профили Connection Manager, которые Nanovia создаёт и обновляет).
2. **Закрыть все вкладки ST** (и на телефоне тоже): открытая вкладка со старым состоянием при сохранении перезапишет `settings.json` и потеряет профили.

**Первая установка** (пути примерные, свои смотрите в `docker-compose.yml`):

```bash
cd /opt/sillytavern/extensions        # папка, смонтированная в .../extensions/third-party
git clone https://github.com/Likerch/SillyTavern-Nanovia
sh SillyTavern-Nanovia/scripts/install-server.sh /opt/sillytavern    # копирует server/ в /opt/sillytavern/plugins/nanovia
```

Если репозиторий приватный, расширение и плагин выкладываются бандлом: `git bundle` или `scp` собранных `manifest.json`, `dist/`, `server/index.js`, `server/package.json`. Результат тот же: расширение в `extensions/SillyTavern-Nanovia`, плагин в `plugins/nanovia`.

Включить плагины: `enableServerPlugins: true` в `config.yaml` **или** переменная окружения контейнера `SILLYTAVERN_ENABLESERVERPLUGINS=true` (переменная перекрывает файл). Затем `docker compose up -d`.

**Обновление** (только быстрая перемотка, без слияний):

```bash
cd /opt/sillytavern/extensions/SillyTavern-Nanovia
git -c safe.directory='*' fetch origin
git -c safe.directory='*' merge --ff-only origin/main
sh scripts/install-server.sh /opt/sillytavern
docker compose restart sillytavern        # плагин ST грузит только при старте
```

`-c safe.directory='*'` нужен, когда папка принадлежит пользователю контейнера. Расширение после обновления достаточно открыть заново (перезагрузка страницы), плагину нужен перезапуск контейнера. Расширение с `auto_update: true` ST может обновить сам через интерфейс; плагин, скопированный скриптом (не клоном), `enableServerPluginsAutoUpdate` не трогает.

### Конфиг плагина

Файл `<ST>/plugins/nanovia/config.json` (в git не попадает, скрипты установки его не перезаписывают). Все ключи необязательны:

| Ключ           | По умолчанию                       | Смысл                                                                          |
| -------------- | ---------------------------------- | ------------------------------------------------------------------------------ |
| `port`         | `8787`                             | порт локального прокси (слушает только `127.0.0.1`)                            |
| `upstreamBase` | `https://api.nano-gpt.com/api/v1`  | куда пересылать запросы (при ошибках соединения плагин пробует `https://nano-gpt.com/api/v1`) |
| `timeoutMs`    | задаёт плагин                      | таймаут запроса к NanoGPT                                                       |

Переменные окружения `NANOVIA_PORT` и `NANOVIA_UPSTREAM` перекрывают файл. Ключ NanoGPT в конфиг не кладут: он берётся из секретов ST (`api_key_nanogpt`).

### Файрвол и порты

Порт прокси (по умолчанию 8787) **внутренний**: плагин слушает `127.0.0.1` внутри контейнера, и к нему обращается серверная часть самого ST из того же контейнера. Не публиковать его в `ports:` compose-файла и не открывать в `ufw`/облачном файрволе: прокси принимает запросы по токену подключения, но наружу ему выходить незачем. Наружу смотрит только порт ST (8000), и он уже закрыт вашей схемой доступа (белый список, basic auth, обратный прокси).

### Проверка

```bash
docker exec <контейнер> node -e "fetch('http://127.0.0.1:8787/health').then(r=>r.text()).then(console.log)"
```

Ожидается `{"ok":true,"version":"…"}` (маршрут `GET /health` из `docs/ARCHITECTURE.md`, п. 4; любой HTTP-ответ на порту значит, что прокси жив). В панели расширения плагин должен показываться как доступный; если прокси не отвечает, панель предложит переключить подключение в прямой режим.

### Откат и удаление

- Откат расширения: `git -c safe.directory='*' checkout <прежний коммит>` в папке расширения (или вернуть копию), затем перезагрузить страницу; плагина — скопировать прежний `server/index.js` и перезапустить контейнер. Профили в `settings.json` вернуть из копии (все вкладки ST закрыты).
- Удаление: Extensions → Manage extensions → Nanovia → Delete (профили `Nanovia · …` удалить в Connection Manager), затем удалить `plugins/nanovia` и перезапустить ST. Секреты `Nanovia: …` в хранилище ключей ST убрать вручную.

---

## 5. Если что-то не работает

| Симптом                                                    | Что проверить                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Нет `plugin proxy up` после `npm run stand`                | `npm run build:server`, затем `npm run stand -- restart`; `npm run stand -- logs st`                    |
| Плагин не загрузился в боевом ST                           | `enableServerPlugins`/`SILLYTAVERN_ENABLESERVERPLUGINS`, папка `plugins/nanovia` с `index.js` и `package.json`, перезапуск контейнера |
| `port 8130 is taken by another process`                    | другой ST на порту; поменять `STAND_ST_PORT`                                                            |
| Мок отвечает `401 malformed_api_key`                       | ключ должен быть `sk-nano-` и ещё минимум 8 символов                                                    |
| В мок попадает не то, что ждёшь                            | `http://127.0.0.1:5300/__mock/requests` (заголовки с маской ключа, разобранное тело, статус)            |
| `deploy-local: Not a SillyTavern folder`                   | передать `--st <папка>` или задать `NANOVIA_ST_DIR`                                                     |
| Профили Nanovia пропали после работы                       | вкладка ST со старым состоянием перезаписала `settings.json`; восстановить из копии, закрывать все вкладки перед деплоем |
