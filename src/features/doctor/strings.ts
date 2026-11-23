// Strings of the «Diagnostics» tab. Keys are namespaced `doctor.*`; every English key has a Russian one. The words of
// each finding are `doctor.check.<code>.title` / `.detail` for every code of src/domain/doctor.ts (DOCTOR_CODES).
import type { I18nParts } from '../../core/types';

export const DOCTOR_STRINGS: I18nParts = {
    en: {
        'doctor.tab': 'Diagnostics',
        'doctor.hint':
            'Looks over the plugin, SillyTavern, the keys, the catalog and every connection, and says what to fix.',
        'doctor.run': 'Run checks',
        'doctor.running': 'Checking…',
        'doctor.headline.error': 'Something needs fixing',
        'doctor.headline.warn': 'Worth a look',
        'doctor.headline.info': 'Nothing is broken; a few notes',
        'doctor.headline.ok': 'Everything looks fine',
        'doctor.group.error': 'Errors',
        'doctor.group.warn': 'Warnings',
        'doctor.group.info': 'Notes',
        'doctor.group.ok': 'In order',
        'doctor.level.error': 'Error',
        'doctor.level.warn': 'Warning',
        'doctor.level.info': 'Note',
        'doctor.level.ok': 'OK',
        'doctor.noReason': 'no reason given',
        'doctor.notice.fixed': 'Done.',

        'doctor.fix.refresh': 'Refresh',
        'doctor.fix.refreshCatalog': 'Reload the catalog',
        'doctor.fix.repair-profile': 'Repair the profile',
        'doctor.fix.switch-direct': 'Switch to direct mode',
        'doctor.fix.check-key': 'Check the key again',
        'doctor.fix.open-tab': 'Open "{tab}"',
        'doctor.fix.error.missing_target': 'The fix has nothing to act on.',
        'doctor.fix.error.no_panel': 'The panel cannot be opened from here.',
        'doctor.fix.error.unexpected': 'The fix failed unexpectedly. Details are in the browser console.',
        'doctor.fix.error.unknown': 'The fix did not work ({code}).',

        'doctor.reason.not_installed':
            'SillyTavern does not know the Nanovia plugin: it is not installed or not enabled.',
        'doctor.reason.unreachable': 'There was no answer from the SillyTavern server.',
        'doctor.reason.timeout': 'The plugin did not answer in time.',
        'doctor.reason.forbidden': 'SillyTavern refused the request (session or CSRF check). Reload the page.',
        'doctor.reason.other': 'The plugin sent an unexpected answer ({code}).',
        'doctor.catalog.notLoaded': 'It has not been loaded yet.',
        'doctor.catalog.failed': 'The last load failed: {reason}.',
        'doctor.window.daily': 'daily',
        'doctor.window.weekly': 'weekly',

        'doctor.check.plugin_ok.title': 'The plugin is running',
        'doctor.check.plugin_ok.detail':
            'Port {port}, version {version}. The proxy listens and the key store is reachable.',
        'doctor.check.plugin_down.title': 'The plugin is not answering',
        'doctor.check.plugin_down.detail':
            '{reason} Connections in "automatic" mode go straight to NanoGPT meanwhile; connections that insist on the plugin wait for it.',
        'doctor.check.proxy_down.title': 'The plugin proxy is not listening',
        'doctor.check.proxy_down.detail':
            'The plugin answers, but nothing listens on port {port}. Connections that go through the plugin cannot reach NanoGPT until it does. Check that the port is free and restart SillyTavern.',
        'doctor.check.secrets_unavailable.title': 'The plugin cannot reach SillyTavern’s secret store',
        'doctor.check.secrets_unavailable.detail':
            'It works in a degraded mode: it cannot list your NanoGPT keys or issue proxy tokens. This usually means a SillyTavern version the plugin does not know; update SillyTavern or the plugin.',
        'doctor.check.st_version_ok.title': 'SillyTavern {version}',
        'doctor.check.st_version_ok.detail': 'This version is supported.',
        'doctor.check.st_version_old.title': 'SillyTavern is older than {required}',
        'doctor.check.st_version_old.detail':
            'You run {version}. Nanovia is built for SillyTavern {required} or newer; the request hook and Connection Manager requests may not work. Update SillyTavern.',
        'doctor.check.connection_manager_missing.title': 'Connection Manager is not available',
        'doctor.check.connection_manager_missing.detail':
            'Nanovia connections show up in SillyTavern as Connection Manager profiles. Enable the built-in Connection Manager extension and reload the page.',
        'doctor.check.keys_ok.title': 'The NanoGPT keys are in place',
        'doctor.check.keys_ok.detail': '{count} key(s) on file; {passed} confirmed by a balance check.',
        'doctor.check.no_keys.title': 'There is no NanoGPT key',
        'doctor.check.no_keys.detail': 'The plugin has no NanoGPT key to call NanoGPT with. Add one in the Keys tab.',
        'doctor.check.key_rejected.title': 'The key "{label}" did not pass the check',
        'doctor.check.key_rejected.detail':
            'NanoGPT answered: {reason}. If the key was revoked or mistyped, replace it in the Keys tab; otherwise check again in a moment.',
        'doctor.check.catalog_ok.title': 'The model catalog is loaded',
        'doctor.check.catalog_ok.detail': '{count} models are known.',
        'doctor.check.catalog_empty.title': 'The model catalog is empty',
        'doctor.check.catalog_empty.detail':
            'Without it Nanovia cannot check models, prices or what a setting does to your subscription. {reason}',
        'doctor.check.catalog_stale.title': 'The model catalog is out of date',
        'doctor.check.catalog_stale.detail':
            'NanoGPT could not be reached, or the list was last refreshed more than a day ago. Prices and which models are available may have changed.',
        'doctor.check.connection_ok.title': '"{name}": no problems',
        'doctor.check.connection_ok.detail': 'Model {model}; the settings, the profile and the billing look fine.',
        'doctor.check.model_unknown_or_paused.title': 'The model of "{name}" is not in the catalog',
        'doctor.check.model_unknown_or_paused.detail':
            '{model} is not listed: NanoGPT may have paused or removed it, or the id has a typo. Requests may fail. Check the model id in the Connections tab.',
        'doctor.check.profile_missing.title': 'No Connection Manager profile for "{name}"',
        'doctor.check.profile_missing.detail':
            'The connection will not show up in SillyTavern’s list of connections until its profile exists.',
        'doctor.check.profile_drifted.title': 'The profile of "{name}" was changed',
        'doctor.check.profile_drifted.detail':
            'Its name, model or address no longer matches the connection, for example it was edited in Connection Manager. Repair it so SillyTavern uses the connection’s settings again.',
        'doctor.check.profile_blocked.title': 'The profile of "{name}" cannot be created',
        'doctor.check.profile_blocked.detail':
            'A profile needs a proxy token (plugin mode) or your NanoGPT key (direct mode), and neither is available yet.',
        'doctor.check.profile_orphan.title': '"{name}" is not on the plugin',
        'doctor.check.profile_orphan.detail':
            'The plugin does not have this connection although its mode needs it there. Send it to the plugin from the Connections tab, or delete it.',
        'doctor.check.profile_pending.title': '"{name}" is waiting for the plugin',
        'doctor.check.profile_pending.detail':
            'It was edited while the plugin did not answer and has not reached it yet. It is sent on the next refresh.',
        'doctor.check.direct_without_key.title': '"{name}" has no key for direct mode',
        'doctor.check.direct_without_key.detail':
            'Direct mode needs your NanoGPT key, entered once in the connection’s form. Without it requests cannot be signed.',
        'doctor.check.plugin_mode_but_down.title': '"{name}" needs the plugin, which is not answering',
        'doctor.check.plugin_mode_but_down.detail':
            'This connection goes through the plugin only, so it does not work now. Switch it to direct mode or start the plugin.',
        'doctor.check.leaves_subscription.title': '"{name}" takes requests off the subscription',
        'doctor.check.leaves_subscription.detail': '{reason} This costs money beyond your subscription.',
        'doctor.check.memory_on.title': 'Context Memory is on for "{name}"',
        'doctor.check.memory_on.detail':
            'NanoGPT bills it separately from the subscription. It is off by default; turn it off in the connection’s form if you did not mean to use it.',
        'doctor.check.memory_overlaps_qvink.title': 'Context Memory and Qvink Memory both summarise "{name}"',
        'doctor.check.memory_overlaps_qvink.detail':
            'Both keep a summary of the same chat: you pay twice and the two can contradict each other. Keep one of them.',
        'doctor.check.reasoning_always_on_for_background.title': '{model} always reasons',
        'doctor.check.reasoning_always_on_for_background.detail':
            'If "{name}" is used for background tasks (summaries, extraction, JSON), every call spends reasoning tokens. For such work pick a model that reasons only on request.',
        'doctor.check.mgmt_token_missing.title': 'No Management API token',
        'doctor.check.mgmt_token_missing.detail':
            'The features that use NanoGPT’s Management API are off until you add the token.',
        'doctor.check.low_balance.title': 'Low balance: ${balance}',
        'doctor.check.low_balance.detail':
            'Connections billed per token ({names}) draw on this balance. Top it up on the NanoGPT site before it runs out.',
        'doctor.check.subscription_quota_high.title': 'The {window} subscription quota is {percent}% used',
        'doctor.check.subscription_quota_high.detail':
            'When it runs out NanoGPT bills requests per token until it resets. Slow down, or expect pay-as-you-go charges.',
        'doctor.check.doctor_failed.title': 'The checks could not be completed',
        'doctor.check.doctor_failed.detail': '{message}',
    },
    ru: {
        'doctor.tab': 'Диагностика',
        'doctor.hint':
            'Смотрит плагин, SillyTavern, ключи, каталог и каждое подключение и подсказывает, что исправить.',
        'doctor.run': 'Запустить проверки',
        'doctor.running': 'Проверяю…',
        'doctor.headline.error': 'Кое-что нужно исправить',
        'doctor.headline.warn': 'Стоит взглянуть',
        'doctor.headline.info': 'Ничего не сломано; есть пара заметок',
        'doctor.headline.ok': 'Всё в порядке',
        'doctor.group.error': 'Ошибки',
        'doctor.group.warn': 'Предупреждения',
        'doctor.group.info': 'Заметки',
        'doctor.group.ok': 'В порядке',
        'doctor.level.error': 'Ошибка',
        'doctor.level.warn': 'Предупреждение',
        'doctor.level.info': 'Заметка',
        'doctor.level.ok': 'Норма',
        'doctor.noReason': 'причина не указана',
        'doctor.notice.fixed': 'Готово.',

        'doctor.fix.refresh': 'Обновить',
        'doctor.fix.refreshCatalog': 'Обновить каталог',
        'doctor.fix.repair-profile': 'Починить профиль',
        'doctor.fix.switch-direct': 'Перейти на прямой режим',
        'doctor.fix.check-key': 'Проверить ключ ещё раз',
        'doctor.fix.open-tab': 'Открыть «{tab}»',
        'doctor.fix.error.missing_target': 'У исправления нет цели.',
        'doctor.fix.error.no_panel': 'Отсюда панель открыть нельзя.',
        'doctor.fix.error.unexpected': 'Исправление не удалось. Подробности в консоли браузера.',
        'doctor.fix.error.unknown': 'Исправление не сработало ({code}).',

        'doctor.reason.not_installed': 'SillyTavern не знает плагин Nanovia: он не установлен или не включён.',
        'doctor.reason.unreachable': 'Сервер SillyTavern не ответил.',
        'doctor.reason.timeout': 'Плагин не ответил вовремя.',
        'doctor.reason.forbidden': 'SillyTavern отклонил запрос (проверка сессии или CSRF). Перезагрузите страницу.',
        'doctor.reason.other': 'Плагин прислал неожиданный ответ ({code}).',
        'doctor.catalog.notLoaded': 'Он ещё не загружен.',
        'doctor.catalog.failed': 'Последняя загрузка не удалась: {reason}.',
        'doctor.window.daily': 'за день',
        'doctor.window.weekly': 'за неделю',

        'doctor.check.plugin_ok.title': 'Плагин работает',
        'doctor.check.plugin_ok.detail':
            'Порт {port}, версия {version}. Прокси слушает порт, хранилище ключей доступно.',
        'doctor.check.plugin_down.title': 'Плагин не отвечает',
        'doctor.check.plugin_down.detail':
            '{reason} Подключения в режиме «автоматически» пока идут напрямую в NanoGPT; подключения, которым нужен плагин, ждут его.',
        'doctor.check.proxy_down.title': 'Прокси плагина не слушает порт',
        'doctor.check.proxy_down.detail':
            'Плагин отвечает, но порт {port} никто не слушает. Подключения через плагин не достучатся до NanoGPT, пока это так. Проверьте, что порт свободен, и перезапустите SillyTavern.',
        'doctor.check.secrets_unavailable.title': 'Плагин не видит хранилище секретов SillyTavern',
        'doctor.check.secrets_unavailable.detail':
            'Он работает в урезанном режиме: не может показать ключи NanoGPT и выпускать токены прокси. Обычно это значит, что плагин не знает эту версию SillyTavern; обновите SillyTavern или плагин.',
        'doctor.check.st_version_ok.title': 'SillyTavern {version}',
        'doctor.check.st_version_ok.detail': 'Эта версия поддерживается.',
        'doctor.check.st_version_old.title': 'SillyTavern старше {required}',
        'doctor.check.st_version_old.detail':
            'У вас {version}. Nanovia рассчитана на SillyTavern {required} и новее; перехват запросов и запросы через Connection Manager могут не работать. Обновите SillyTavern.',
        'doctor.check.connection_manager_missing.title': 'Connection Manager недоступен',
        'doctor.check.connection_manager_missing.detail':
            'Подключения Nanovia появляются в SillyTavern как профили Connection Manager. Включите встроенное расширение Connection Manager и перезагрузите страницу.',
        'doctor.check.keys_ok.title': 'Ключи NanoGPT на месте',
        'doctor.check.keys_ok.detail': 'Ключей: {count}; подтверждено проверкой баланса: {passed}.',
        'doctor.check.no_keys.title': 'Нет ключа NanoGPT',
        'doctor.check.no_keys.detail':
            'У плагина нет ключа NanoGPT, чтобы обращаться к NanoGPT. Добавьте его на вкладке «Ключи».',
        'doctor.check.key_rejected.title': 'Ключ «{label}» не прошёл проверку',
        'doctor.check.key_rejected.detail':
            'NanoGPT ответил: {reason}. Если ключ отозван или введён с ошибкой, замените его на вкладке «Ключи»; если нет, проверьте ещё раз чуть позже.',
        'doctor.check.catalog_ok.title': 'Каталог моделей загружен',
        'doctor.check.catalog_ok.detail': 'Известно моделей: {count}.',
        'doctor.check.catalog_empty.title': 'Каталог моделей пуст',
        'doctor.check.catalog_empty.detail':
            'Без него Nanovia не может проверить модели, цены и то, как настройка влияет на подписку. {reason}',
        'doctor.check.catalog_stale.title': 'Каталог моделей устарел',
        'doctor.check.catalog_stale.detail':
            'NanoGPT не отвечал, либо список обновлялся больше суток назад. Цены и набор доступных моделей могли измениться.',
        'doctor.check.connection_ok.title': '«{name}»: без замечаний',
        'doctor.check.connection_ok.detail': 'Модель {model}; настройки, профиль и тариф в порядке.',
        'doctor.check.model_unknown_or_paused.title': 'Модели подключения «{name}» нет в каталоге',
        'doctor.check.model_unknown_or_paused.detail':
            '{model} нет в списке: NanoGPT могла приостановить или убрать её, либо в идентификаторе опечатка. Запросы могут не проходить. Проверьте идентификатор модели на вкладке «Подключения».',
        'doctor.check.profile_missing.title': 'У «{name}» нет профиля Connection Manager',
        'doctor.check.profile_missing.detail':
            'Подключение не появится в списке подключений SillyTavern, пока у него нет профиля.',
        'doctor.check.profile_drifted.title': 'Профиль «{name}» изменили',
        'doctor.check.profile_drifted.detail':
            'Его название, модель или адрес больше не совпадают с подключением, например, его правили в Connection Manager. Почините профиль, чтобы SillyTavern снова использовала настройки подключения.',
        'doctor.check.profile_blocked.title': 'Профиль «{name}» не создать',
        'doctor.check.profile_blocked.detail':
            'Для профиля нужен токен прокси (режим плагина) или ваш ключ NanoGPT (прямой режим), а ни того ни другого пока нет.',
        'doctor.check.profile_orphan.title': '«{name}» нет в плагине',
        'doctor.check.profile_orphan.detail':
            'В плагине нет этого подключения, хотя его режим этого требует. Отправьте его в плагин на вкладке «Подключения» или удалите.',
        'doctor.check.profile_pending.title': '«{name}» ждёт плагин',
        'doctor.check.profile_pending.detail':
            'Его изменили, пока плагин не отвечал, и изменения ещё не дошли до плагина. Они уйдут при следующем обновлении.',
        'doctor.check.direct_without_key.title': 'У «{name}» нет ключа для прямого режима',
        'doctor.check.direct_without_key.detail':
            'Для прямого режима нужен ваш ключ NanoGPT, он вводится один раз в форме подключения. Без него запросы не подписать.',
        'doctor.check.plugin_mode_but_down.title': '«{name}» нужен плагин, а он не отвечает',
        'doctor.check.plugin_mode_but_down.detail':
            'Это подключение работает только через плагин, поэтому сейчас оно не работает. Переключите его на прямой режим или запустите плагин.',
        'doctor.check.leaves_subscription.title': '«{name}» уводит запросы из подписки',
        'doctor.check.leaves_subscription.detail': '{reason} Это стоит денег сверх подписки.',
        'doctor.check.memory_on.title': 'Для «{name}» включена контекстная память',
        'doctor.check.memory_on.detail':
            'NanoGPT оплачивает её отдельно от подписки. По умолчанию она выключена; если вы не хотели её включать, выключите её в форме подключения.',
        'doctor.check.memory_overlaps_qvink.title': 'Контекстная память и Qvink Memory обе пересказывают «{name}»',
        'doctor.check.memory_overlaps_qvink.detail':
            'Обе ведут краткое изложение одного и того же чата: вы платите дважды, а пересказы могут противоречить друг другу. Оставьте что-то одно.',
        'doctor.check.reasoning_always_on_for_background.title': '{model} рассуждает всегда',
        'doctor.check.reasoning_always_on_for_background.detail':
            'Если «{name}» используется для фоновых задач (пересказы, извлечение, JSON), каждый вызов тратит токены на рассуждения. Для такой работы возьмите модель, которая рассуждает только по запросу.',
        'doctor.check.mgmt_token_missing.title': 'Нет токена Management API',
        'doctor.check.mgmt_token_missing.detail':
            'Возможности, которым нужен Management API NanoGPT, выключены, пока вы не добавите токен.',
        'doctor.check.low_balance.title': 'Мало денег на балансе: ${balance}',
        'doctor.check.low_balance.detail':
            'Подключения с оплатой за токены ({names}) списывают деньги с этого баланса. Пополните его на сайте NanoGPT, пока он не кончился.',
        'doctor.check.subscription_quota_high.title': 'Квота подписки {window} израсходована на {percent}%',
        'doctor.check.subscription_quota_high.detail':
            'Когда она кончится, NanoGPT будет брать плату за токены до сброса. Сбавьте темп или ожидайте оплату по факту.',
        'doctor.check.doctor_failed.title': 'Проверки не удалось завершить',
        'doctor.check.doctor_failed.detail': '{message}',
    },
};
