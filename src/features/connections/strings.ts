// Strings of the «Connections» tab. Keys are namespaced `connections.*`; every English key has a Russian one.
import type { I18nParts } from '../../core/types';

export const CONNECTIONS_STRINGS: I18nParts = {
    en: {
        'connections.tab': 'Connections',

        'connections.status.checking': 'Checking the plugin…',
        'connections.status.up': 'Plugin is running',
        'connections.status.upDetail': 'port {port} · version {version}',
        'connections.status.proxyDown':
            'The plugin answers, but its proxy is not listening on port {port}. Plugin-mode connections will not work until it does.',
        'connections.status.down': 'Plugin is not answering',
        'connections.status.reason.not_installed':
            'SillyTavern does not know the Nanovia plugin: it is not installed or not enabled.',
        'connections.status.reason.unreachable': 'There was no answer from the SillyTavern server.',
        'connections.status.reason.timeout': 'The plugin did not answer in time.',
        'connections.status.reason.forbidden':
            'SillyTavern refused the request (session or CSRF check). Reload the page.',
        'connections.status.reason.other': 'The plugin sent an unexpected answer ({code}).',
        'connections.status.installHint':
            'To use plugin mode, copy the plugin folder to plugins/nanovia inside your SillyTavern folder, set enableServerPlugins: true in config.yaml and restart the server. Until then connections can work in direct mode.',
        'connections.refresh': 'Refresh',
        'connections.new': 'New connection',
        'connections.empty':
            'No connections yet. A connection is a named bundle (model, key, billing, reasoning) that shows up in SillyTavern as a Connection Manager profile.',

        'connections.chip.mode.plugin': 'Plugin',
        'connections.chip.mode.direct': 'Direct',
        'connections.chip.mode.autoPlugin': 'Auto → plugin',
        'connections.chip.mode.autoDirect': 'Auto → direct',
        'connections.chip.billing.auto': 'Billing: auto',
        'connections.chip.billing.subscription': 'Subscription only',
        'connections.chip.billing.paygo': 'Pay as you go',
        'connections.chip.profile.linked': 'Profile linked',
        'connections.chip.profile.drifted': 'Profile differs',
        'connections.chip.profile.missing': 'Profile missing',
        'connections.chip.profile.none': 'No profile',
        'connections.chip.profile.blocked': 'Profile blocked',
        'connections.chip.profile.unavailable': 'No Connection Manager',
        'connections.chip.pending': 'Waiting for the plugin',
        'connections.chip.orphan': 'Not on the plugin',
        'connections.chip.noKey': 'No direct key',
        'connections.chip.noKey.hint': 'Direct mode needs your NanoGPT key. Edit the connection and enter it once.',
        'connections.chip.pending.hint': 'Edited while the plugin was down; it will be sent when the plugin answers.',
        'connections.chip.orphan.hint': 'The plugin does not have this connection. Send it to the plugin or delete it.',
        'connections.chip.profile.blocked.hint': 'A profile needs a proxy token (plugin mode) or a key (direct mode).',

        'connections.action.edit': 'Edit',
        'connections.action.delete': 'Delete',
        'connections.action.rotate': 'New token',
        'connections.action.rotate.hint': 'Issues a new proxy token and updates the profile.',
        'connections.action.switchDirect': 'Switch to direct mode',
        'connections.action.switchDirect.hint': 'Connects straight to NanoGPT while the plugin is down.',
        'connections.action.repairProfile': 'Create profile',
        'connections.action.repairProfile.fix': 'Repair profile',
        'connections.action.sendToPlugin': 'Send to plugin',

        'connections.confirm.title': 'Delete connection',
        'connections.confirm.delete':
            'Delete the connection "{name}", its Connection Manager profile and its stored key?',

        'connections.form.titleNew': 'New connection',
        'connections.form.titleEdit': 'Edit connection',
        'connections.form.name': 'Name',
        'connections.form.nameHint': 'Shown in the list and in the profile name ("Nanovia · …").',
        'connections.form.model': 'Model id',
        'connections.form.modelHint':
            'NanoGPT model id, for example deepseek/deepseek-v4. Variants such as :thinking are part of the id.',
        'connections.form.mode': 'How it connects',
        'connections.mode.auto': 'Automatic',
        'connections.mode.plugin': 'Through the plugin',
        'connections.mode.direct': 'Direct to NanoGPT',
        'connections.mode.auto.hint': 'Through the plugin while it answers, directly otherwise.',
        'connections.mode.plugin.hint':
            'Through the local Nanovia proxy: routing, billing safety and usage tracking work.',
        'connections.mode.direct.hint': 'Straight from the browser to NanoGPT. Needs your NanoGPT key, entered once.',
        'connections.form.key': 'NanoGPT key',
        'connections.form.keyActive': 'The active key',
        'connections.form.keyHint': 'Which of the keys the plugin knows this connection uses.',
        'connections.form.keysUnavailable': 'The key list needs the plugin.',
        'connections.key.add': 'Add a key',
        'connections.key.name': 'Key name',
        'connections.key.value': 'Paste the key here',
        'connections.key.save': 'Save key',
        'connections.key.hint': 'The key goes to the plugin and is never shown again.',
        'connections.key.added': 'Key added.',
        'connections.form.directKey': 'NanoGPT key',
        'connections.form.directKeyHint': "Written to SillyTavern's secret store once; Nanovia keeps only its id.",
        'connections.form.directKeyOnFile': 'A key is on file. Type a new one only to replace it.',
        'connections.form.billing': 'Billing',
        'connections.billing.auto': 'Automatic',
        'connections.billing.subscription': 'Subscription only',
        'connections.billing.paygo': 'Pay as you go',
        'connections.billing.auto.hint':
            'Any setting is allowed; Nanovia warns when a setting takes a request out of your subscription.',
        'connections.billing.subscription.hint':
            'Settings that would bill outside the subscription are blocked or removed.',
        'connections.billing.paygo.hint': 'Always billed pay-as-you-go, whatever the model offers.',
        'connections.form.reasoning': 'Reasoning',
        'connections.reasoning.follow': 'Follow the request',
        'connections.reasoning.fixed': 'Fixed effort',
        'connections.reasoning.off': 'Off',
        'connections.reasoning.default': 'Model default',
        'connections.reasoning.follow.hint':
            'Takes the effort SillyTavern asked for and translates it to what the model supports.',
        'connections.reasoning.fixed.hint': 'Always the effort below.',
        'connections.reasoning.off.hint':
            'No reasoning when the model allows it; the lowest effort, text hidden, when it always reasons.',
        'connections.reasoning.default.hint': 'Sends nothing: the model decides.',
        'connections.form.effort': 'Reasoning effort',
        'connections.effort.none': 'None',
        'connections.effort.minimal': 'Minimal',
        'connections.effort.low': 'Low',
        'connections.effort.medium': 'Medium',
        'connections.effort.high': 'High',
        'connections.effort.xhigh': 'Extra high',
        'connections.effort.max': 'Max',
        'connections.form.hideThoughts': 'Leave the reasoning text out of the reply',
        'connections.form.webSearch': 'Web search (adds :online, billed separately)',
        'connections.form.memory': 'NanoGPT Context Memory',
        'connections.form.memoryHint':
            'Adds :memory to the model so NanoGPT keeps the context of the chat on its side. Billed separately from the subscription; off by default.',
        'connections.form.memoryDays': 'Keep for N days',
        'connections.form.memoryDaysPlaceholder': 'default',
        'connections.form.memoryDaysHint':
            'Leave empty for NanoGPT’s own default (:memory). A whole number from 1 to 365 adds :memory-N.',
        'connections.form.memoryQvink':
            'Qvink Memory is on and also keeps a summary of your chats. Both together mean paying for two summaries that can contradict each other; keep one of them.',
        'connections.form.note': 'Note',
        'connections.form.save': 'Save',
        'connections.form.cancel': 'Cancel',
        'connections.form.offline':
            'The plugin is not answering. Plugin-mode settings are saved here and sent when it is back.',

        'connections.field.name': 'name',
        'connections.field.modelId': 'model id',

        'connections.notice.saved': 'Connection saved.',
        'connections.notice.deleted': 'Connection deleted.',
        'connections.notice.rotated': 'New token issued and the profile updated.',
        'connections.notice.profile': 'Profile updated.',
        'connections.notice.sent': 'Sent to the plugin.',
        'connections.notice.switched': 'Switched to direct mode.',
        'connections.notice.refreshed': 'Refreshed.',

        'connections.issue.plugin_down':
            'The plugin is not answering. Choose direct mode, or start the plugin and try again.',
        'connections.issue.plugin_error': 'The plugin refused the request: {message}',
        'connections.issue.direct_key_required': 'Enter your NanoGPT key: direct mode needs it once.',
        'connections.issue.key_write_failed': 'SillyTavern did not accept the key ({message}).',
        'connections.issue.not_found': 'This connection no longer exists.',
        'connections.issue.invalid': 'The {field} is required.',
        'connections.issue.invalid_memory_days':
            'Days of Context Memory must be a whole number from 1 to 365, or empty for the default.',
        'connections.issue.not_on_plugin': 'The plugin does not have this connection.',
        'connections.issue.saved_locally': 'Saved here; it will be sent to the plugin when it answers.',
        'connections.issue.profile_unavailable':
            'Connection Manager is not installed or is disabled, so no profile was written.',
        'connections.issue.profile_needs_token': 'No proxy token yet, so the profile was not written.',
        'connections.issue.profile_needs_key': 'No NanoGPT key on file, so the profile was not written.',
        'connections.issue.profile_failed': 'The profile could not be written.',
        'connections.issue.key_not_removed':
            'The stored key could not be removed from SillyTavern; delete it there if you like.',
    },
    ru: {
        'connections.tab': 'Подключения',

        'connections.status.checking': 'Проверяю плагин…',
        'connections.status.up': 'Плагин работает',
        'connections.status.upDetail': 'порт {port} · версия {version}',
        'connections.status.proxyDown':
            'Плагин отвечает, но его прокси не слушает порт {port}. Подключения через плагин не заработают, пока это так.',
        'connections.status.down': 'Плагин не отвечает',
        'connections.status.reason.not_installed':
            'SillyTavern не знает плагин Nanovia: он не установлен или не включён.',
        'connections.status.reason.unreachable': 'Сервер SillyTavern не ответил.',
        'connections.status.reason.timeout': 'Плагин не ответил вовремя.',
        'connections.status.reason.forbidden':
            'SillyTavern отклонил запрос (проверка сессии или CSRF). Перезагрузите страницу.',
        'connections.status.reason.other': 'Плагин прислал неожиданный ответ ({code}).',
        'connections.status.installHint':
            'Чтобы работать через плагин, скопируйте папку плагина в plugins/nanovia внутри папки SillyTavern, включите enableServerPlugins: true в config.yaml и перезапустите сервер. Пока этого нет, подключения могут работать напрямую.',
        'connections.refresh': 'Обновить',
        'connections.new': 'Новое подключение',
        'connections.empty':
            'Подключений пока нет. Подключение — это именованный набор (модель, ключ, тариф, рассуждения), который появляется в SillyTavern как профиль Connection Manager.',

        'connections.chip.mode.plugin': 'Плагин',
        'connections.chip.mode.direct': 'Напрямую',
        'connections.chip.mode.autoPlugin': 'Авто → плагин',
        'connections.chip.mode.autoDirect': 'Авто → напрямую',
        'connections.chip.billing.auto': 'Тариф: авто',
        'connections.chip.billing.subscription': 'Только подписка',
        'connections.chip.billing.paygo': 'Оплата по факту',
        'connections.chip.profile.linked': 'Профиль связан',
        'connections.chip.profile.drifted': 'Профиль отличается',
        'connections.chip.profile.missing': 'Профиль пропал',
        'connections.chip.profile.none': 'Нет профиля',
        'connections.chip.profile.blocked': 'Профиль не создать',
        'connections.chip.profile.unavailable': 'Нет Connection Manager',
        'connections.chip.pending': 'Ждёт плагин',
        'connections.chip.orphan': 'Нет в плагине',
        'connections.chip.noKey': 'Нет ключа',
        'connections.chip.noKey.hint':
            'Для прямого режима нужен ваш ключ NanoGPT. Откройте подключение и введите его один раз.',
        'connections.chip.pending.hint': 'Изменено, пока плагин не отвечал; уйдёт в плагин, когда он ответит.',
        'connections.chip.orphan.hint': 'В плагине нет этого подключения. Отправьте его в плагин или удалите.',
        'connections.chip.profile.blocked.hint':
            'Для профиля нужен токен прокси (режим плагина) или ключ (прямой режим).',

        'connections.action.edit': 'Изменить',
        'connections.action.delete': 'Удалить',
        'connections.action.rotate': 'Новый токен',
        'connections.action.rotate.hint': 'Выпускает новый токен прокси и обновляет профиль.',
        'connections.action.switchDirect': 'Перейти на прямой режим',
        'connections.action.switchDirect.hint': 'Подключается прямо к NanoGPT, пока плагин не отвечает.',
        'connections.action.repairProfile': 'Создать профиль',
        'connections.action.repairProfile.fix': 'Починить профиль',
        'connections.action.sendToPlugin': 'Отправить в плагин',

        'connections.confirm.title': 'Удаление подключения',
        'connections.confirm.delete':
            'Удалить подключение «{name}», его профиль Connection Manager и сохранённый ключ?',

        'connections.form.titleNew': 'Новое подключение',
        'connections.form.titleEdit': 'Изменение подключения',
        'connections.form.name': 'Название',
        'connections.form.nameHint': 'Показывается в списке и в названии профиля («Nanovia · …»).',
        'connections.form.model': 'Идентификатор модели',
        'connections.form.modelHint':
            'Идентификатор модели NanoGPT, например deepseek/deepseek-v4. Варианты вроде :thinking входят в идентификатор.',
        'connections.form.mode': 'Как подключаться',
        'connections.mode.auto': 'Автоматически',
        'connections.mode.plugin': 'Через плагин',
        'connections.mode.direct': 'Напрямую в NanoGPT',
        'connections.mode.auto.hint': 'Через плагин, пока он отвечает, иначе напрямую.',
        'connections.mode.plugin.hint':
            'Через локальный прокси Nanovia: работают маршрутизация, защита подписки и учёт расхода.',
        'connections.mode.direct.hint': 'Из браузера прямо в NanoGPT. Нужен ваш ключ NanoGPT, вводится один раз.',
        'connections.form.key': 'Ключ NanoGPT',
        'connections.form.keyActive': 'Активный ключ',
        'connections.form.keyHint': 'Какой из ключей, известных плагину, использует это подключение.',
        'connections.form.keysUnavailable': 'Список ключей доступен только через плагин.',
        'connections.key.add': 'Добавить ключ',
        'connections.key.name': 'Название ключа',
        'connections.key.value': 'Вставьте ключ сюда',
        'connections.key.save': 'Сохранить ключ',
        'connections.key.hint': 'Ключ уходит в плагин и больше нигде не показывается.',
        'connections.key.added': 'Ключ добавлен.',
        'connections.form.directKey': 'Ключ NanoGPT',
        'connections.form.directKeyHint':
            'Записывается в хранилище секретов SillyTavern один раз; Nanovia помнит только его идентификатор.',
        'connections.form.directKeyOnFile': 'Ключ уже сохранён. Вводите новый, только если хотите заменить.',
        'connections.form.billing': 'Тариф',
        'connections.billing.auto': 'Автоматически',
        'connections.billing.subscription': 'Только подписка',
        'connections.billing.paygo': 'Оплата по факту',
        'connections.billing.auto.hint':
            'Разрешены любые настройки; Nanovia предупредит, если настройка выводит запрос за пределы подписки.',
        'connections.billing.subscription.hint':
            'Настройки, из-за которых запрос оплачивался бы вне подписки, блокируются или убираются.',
        'connections.billing.paygo.hint': 'Всегда оплата по факту, что бы ни предлагала модель.',
        'connections.form.reasoning': 'Рассуждения',
        'connections.reasoning.follow': 'Как в запросе',
        'connections.reasoning.fixed': 'Фиксированный уровень',
        'connections.reasoning.off': 'Выключены',
        'connections.reasoning.default': 'По умолчанию модели',
        'connections.reasoning.follow.hint':
            'Берёт уровень, который запросил SillyTavern, и переводит в то, что поддерживает модель.',
        'connections.reasoning.fixed.hint': 'Всегда уровень, выбранный ниже.',
        'connections.reasoning.off.hint':
            'Без рассуждений, если модель позволяет; если рассуждает всегда — минимальный уровень со скрытым текстом.',
        'connections.reasoning.default.hint': 'Ничего не отправляет: решает модель.',
        'connections.form.effort': 'Уровень рассуждений',
        'connections.effort.none': 'Нет',
        'connections.effort.minimal': 'Минимальный',
        'connections.effort.low': 'Низкий',
        'connections.effort.medium': 'Средний',
        'connections.effort.high': 'Высокий',
        'connections.effort.xhigh': 'Очень высокий',
        'connections.effort.max': 'Максимальный',
        'connections.form.hideThoughts': 'Не включать текст рассуждений в ответ',
        'connections.form.webSearch': 'Веб-поиск (добавляет :online, оплачивается отдельно)',
        'connections.form.memory': 'Контекстная память NanoGPT',
        'connections.form.memoryHint':
            'Добавляет :memory к модели: NanoGPT хранит контекст чата у себя. Оплачивается отдельно от подписки; по умолчанию выключена.',
        'connections.form.memoryDays': 'Хранить N дней',
        'connections.form.memoryDaysPlaceholder': 'по умолчанию',
        'connections.form.memoryDaysHint':
            'Пустое поле — срок NanoGPT по умолчанию (:memory). Целое число от 1 до 365 добавляет :memory-N.',
        'connections.form.memoryQvink':
            'Qvink Memory включена и тоже ведёт краткое изложение ваших чатов. Вместе это два пересказа, которые могут противоречить друг другу, и вы платите за оба; оставьте что-то одно.',
        'connections.form.note': 'Заметка',
        'connections.form.save': 'Сохранить',
        'connections.form.cancel': 'Отмена',
        'connections.form.offline':
            'Плагин не отвечает. Настройки режима плагина сохранятся здесь и уйдут в плагин, когда он вернётся.',

        'connections.field.name': 'название',
        'connections.field.modelId': 'идентификатор модели',

        'connections.notice.saved': 'Подключение сохранено.',
        'connections.notice.deleted': 'Подключение удалено.',
        'connections.notice.rotated': 'Выпущен новый токен, профиль обновлён.',
        'connections.notice.profile': 'Профиль обновлён.',
        'connections.notice.sent': 'Отправлено в плагин.',
        'connections.notice.switched': 'Переключено на прямой режим.',
        'connections.notice.refreshed': 'Обновлено.',

        'connections.issue.plugin_down': 'Плагин не отвечает. Выберите прямой режим или запустите плагин и повторите.',
        'connections.issue.plugin_error': 'Плагин отклонил запрос: {message}',
        'connections.issue.direct_key_required': 'Введите ключ NanoGPT: для прямого режима он нужен один раз.',
        'connections.issue.key_write_failed': 'SillyTavern не принял ключ ({message}).',
        'connections.issue.not_found': 'Такого подключения уже нет.',
        'connections.issue.invalid': 'Поле «{field}» обязательно.',
        'connections.issue.invalid_memory_days':
            'Срок хранения контекстной памяти — целое число дней от 1 до 365; пустое поле означает значение по умолчанию.',
        'connections.issue.not_on_plugin': 'В плагине нет этого подключения.',
        'connections.issue.saved_locally': 'Сохранено здесь; уйдёт в плагин, когда он ответит.',
        'connections.issue.profile_unavailable':
            'Connection Manager не установлен или выключен, поэтому профиль не записан.',
        'connections.issue.profile_needs_token': 'Токена прокси ещё нет, поэтому профиль не записан.',
        'connections.issue.profile_needs_key': 'Нет сохранённого ключа NanoGPT, поэтому профиль не записан.',
        'connections.issue.profile_failed': 'Профиль не удалось записать.',
        'connections.issue.key_not_removed':
            'Сохранённый ключ не удалось убрать из SillyTavern; при желании удалите его там.',
    },
};
