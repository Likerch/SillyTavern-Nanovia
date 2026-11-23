// Strings of the «Routing» tab. Keys are namespaced `routing.*`; every English key has a Russian one. The texts of billing
// reasons and plan warnings (`billing.reason.*`, `plan.warning.*`) live in core/billing-view.ts, shared with other views.
import type { I18nParts } from '../../core/types';

export const ROUTING_STRINGS: I18nParts = {
    en: {
        'routing.tab': 'Routing',
        'routing.connection': 'Connection',
        'routing.save': 'Save',
        'routing.revert': 'Revert',
        'routing.dirty': 'Unsaved changes',
        'routing.empty': 'No connections yet. Create one in the Connections tab, then set its routing here.',
        'routing.confirm.title': 'Unsaved changes',
        'routing.confirm.discard': 'Discard the unsaved changes of this connection?',
        'routing.notice.saved': 'Saved.',
        'routing.notice.reverted': 'Changes discarded.',
        'routing.header.badge.hint': 'What the settings below do to the billing of a request (live).',

        'routing.section.routing': 'Routing',
        'routing.section.routing.hint':
            'NanoGPT’s provider preferences, OpenRouter style. Most of them select a host explicitly, which NanoGPT bills pay as you go instead of through the subscription.',
        'routing.enabled': 'Send routing preferences',
        'routing.enabled.hint': 'Off: nothing is sent and NanoGPT routes the request itself.',
        'routing.offNote': 'Routing is off: the settings below are kept but nothing is sent.',
        'routing.fixedRoute':
            'This model runs on a fixed route: NanoGPT ignores the routing settings, only zero data retention is sent.',
        'routing.needsSortNow': 'A preferred latency or throughput does nothing until a sort is chosen.',
        'routing.providers.placeholder': 'Type a provider id, press Enter',
        'routing.providers.remove': 'Remove {id}',
        'routing.field.noLimit': 'No limit',
        'routing.disabled.subscriptionSafe':
            'Locked: this connection is subscription-only, so Nanovia would strip this setting. Change the billing mode to use it.',

        'routing.field.order': 'Provider order',
        'routing.field.order.hint': 'Providers are tried in this order.',
        'routing.field.only': 'Only these providers',
        'routing.field.only.hint': 'No other provider is used, even when these fail.',
        'routing.field.ignore': 'Never these providers',
        'routing.field.ignore.hint': 'These providers are skipped.',
        'routing.field.sort': 'Sort',
        'routing.sort.default': 'Platform default',
        'routing.sort.price': 'Cheapest first',
        'routing.sort.throughput': 'Fastest throughput',
        'routing.sort.latency': 'Lowest latency',
        'routing.sort.speed': 'Speed',
        'routing.field.sort.hint': 'How candidate providers are ranked.',
        'routing.field.quantizations': 'Allowed precisions',
        'routing.field.quantizations.hint': 'Only hosts that serve the weights in one of the ticked precisions.',
        'routing.field.minQuantization': 'Minimum precision',
        'routing.field.minQuantization.none': 'No floor',
        'routing.field.minQuantization.hint': 'Hosts below this precision are skipped.',
        'routing.field.maxPrice': 'Price cap (USD per 1M tokens)',
        'routing.field.maxPrice.prompt': 'Prompt',
        'routing.field.maxPrice.completion': 'Completion',
        'routing.field.maxPrice.hint': 'Empty means no cap. Hosts above the cap are skipped.',
        'routing.field.allowFallbacks': 'Allow fallbacks',
        'routing.field.allowFallbacks.hint': 'Off: the request fails instead of moving to another provider.',
        'routing.field.requireParameters': 'Require parameter support',
        'routing.field.requireParameters.hint': 'Only hosts that support every parameter of the request.',
        'routing.field.zdr': 'Zero data retention only',
        'routing.field.zdr.hint': 'Only endpoints that keep no copy of your prompts.',
        'routing.field.zdr.keeps': 'Keeps the subscription: it only narrows the platform’s own routing.',
        'routing.field.preferredMaxLatency': 'Preferred latency (seconds)',
        'routing.field.preferredMaxLatency.hint': 'Needs a sort: it is a preference the sort works with.',
        'routing.field.preferredMinThroughput': 'Preferred throughput (tokens per second)',
        'routing.field.preferredMinThroughput.hint': 'Needs a sort: it is a preference the sort works with.',
        'routing.field.cachingRoute': 'Route for prompt caching',
        'routing.field.cachingRoute.hint': 'Only providers with prompt caching; later requests stay on the same one.',

        'routing.bypass.order':
            'Leaves the subscription: a provider order is an explicit choice, pay as you go plus about {markup}%.',
        'routing.bypass.only':
            'Leaves the subscription: limiting to named providers is pay as you go plus about {markup}%.',
        'routing.bypass.ignore':
            'Leaves the subscription: excluding providers counts as routing, pay as you go plus about {markup}%.',
        'routing.bypass.sort':
            'Leaves the subscription: any sort but the default is pay as you go plus about {markup}%.',
        'routing.bypass.quantizations':
            'Leaves the subscription: choosing precisions selects hosts, pay as you go plus about {markup}%.',
        'routing.bypass.minQuantization':
            'Leaves the subscription: a precision floor selects hosts, pay as you go plus about {markup}%.',
        'routing.bypass.maxPrice':
            'Leaves the subscription: a price cap selects hosts, pay as you go plus about {markup}%.',
        'routing.bypass.allowFallbacks':
            'Leaves the subscription when fallbacks are off: pay as you go plus about {markup}%.',
        'routing.bypass.requireParameters':
            'Leaves the subscription: requiring parameters selects hosts, pay as you go plus about {markup}%.',
        'routing.bypass.preferredMaxLatency':
            'Leaves the subscription: a latency preference is routing, pay as you go plus about {markup}%.',
        'routing.bypass.preferredMinThroughput':
            'Leaves the subscription: a throughput preference is routing, pay as you go plus about {markup}%.',
        'routing.bypass.cachingRoute':
            'May leave the subscription: cache routing pins the host (to be confirmed live).',

        'routing.section.billing': 'Billing',
        'routing.section.billing.hint': 'Whether requests stay inside your NanoGPT subscription.',
        'routing.billing.mode': 'Billing mode',
        'routing.billing.auto': 'Automatic',
        'routing.billing.subscription': 'Subscription only',
        'routing.billing.paygo': 'Pay as you go',
        'routing.billing.auto.hint': 'Any setting is allowed; the verdict below shows what leaves the subscription.',
        'routing.billing.subscription.hint':
            'Settings that would bill outside the subscription are locked, and Nanovia strips them from every request. Zero data retention stays.',
        'routing.billing.paygo.hint': 'Always billed pay as you go, whatever the model offers.',
        'routing.verdict.title': 'Verdict',
        'routing.verdict.markup': '+{percent}% markup',
        'routing.verdict.safe': 'Nothing leaves the subscription',
        'routing.verdict.safe.hint': 'No setting of this connection bypasses the subscription.',
        'routing.verdict.modelUnknown':
            'The catalog does not know this model yet, so the outcome is a guess. It improves when the catalog loads.',
        'routing.verdict.subscription': 'Requests are covered by the subscription.',
        'routing.verdict.paygo': 'Requests are billed per token.',
        'routing.verdict.unknown': 'The billing of these requests cannot be told from the settings alone.',
        'routing.verdict.stripped': 'Nanovia removes these settings from every request: {fields}.',
        'routing.verdict.makeSafe': 'Remove what leaves the subscription',
        'routing.verdict.makeSafe.hint':
            'Resets the settings that bypass the subscription to neutral values; zero data retention stays.',

        'routing.section.reasoning': 'Reasoning',
        'routing.reasoning.policy': 'Reasoning policy',
        'routing.reasoning.follow': 'Follow the request',
        'routing.reasoning.fixed': 'Fixed effort',
        'routing.reasoning.off': 'Off',
        'routing.reasoning.default': 'Model default',
        'routing.reasoning.follow.hint':
            'Takes the effort SillyTavern asked for and maps it to what the model supports. Background tasks without an effort reason as little as possible.',
        'routing.reasoning.fixed.hint': 'Always the effort below.',
        'routing.reasoning.off.hint':
            'No reasoning when the model allows it; the lowest effort with the text hidden when it always reasons.',
        'routing.reasoning.default.hint': 'Sends nothing: the model decides.',
        'routing.reasoning.effort': 'Effort',
        'routing.reasoning.effort.hint': 'Limited to what the model offers when the catalog knows it.',
        'routing.reasoning.hide': 'Leave the reasoning text out of the reply',
        'routing.reasoning.hide.hint': 'Asks NanoGPT not to return the thoughts (reasoning.exclude).',
        'routing.reasoning.caps.unknown':
            'The catalog does not know this model: efforts are not limited and are sent as asked.',
        'routing.reasoning.caps.none': 'This model does not reason: the settings above have no effect.',
        'routing.reasoning.caps.alwaysOn': 'The model always reasons; it cannot be switched off.',
        'routing.reasoning.caps.canDisable': 'The model can be switched off.',
        'routing.reasoning.caps.efforts': 'Efforts: {efforts}.',
        'routing.reasoning.caps.noDial': 'It has no effort dial, only on or off.',
        'routing.preview.title': 'What would be sent',
        'routing.preview.nothing': 'nothing, the model decides',
        'routing.preview.effort': 'effort {effort}',
        'routing.preview.off': 'reasoning off',
        'routing.preview.on': 'reasoning on',
        'routing.preview.hidden': 'text hidden',
        'routing.preview.row.main': 'Chat, no effort asked',
        'routing.preview.row.mainNone': 'Chat asks for no reasoning',
        'routing.preview.row.mainHigh': 'Chat asks for high',
        'routing.preview.row.background': 'Background task',
    },
    ru: {
        'routing.tab': 'Маршрутизация',
        'routing.connection': 'Подключение',
        'routing.save': 'Сохранить',
        'routing.revert': 'Отменить',
        'routing.dirty': 'Есть несохранённые изменения',
        'routing.empty':
            'Подключений пока нет. Создайте его на вкладке «Подключения», затем настройте маршрутизацию здесь.',
        'routing.confirm.title': 'Несохранённые изменения',
        'routing.confirm.discard': 'Отбросить несохранённые изменения этого подключения?',
        'routing.notice.saved': 'Сохранено.',
        'routing.notice.reverted': 'Изменения отброшены.',
        'routing.header.badge.hint': 'Что настройки ниже делают с оплатой запроса (обновляется сразу).',

        'routing.section.routing': 'Маршрутизация',
        'routing.section.routing.hint':
            'Предпочтения по провайдерам NanoGPT в стиле OpenRouter. Большинство из них явно выбирают хост, а NanoGPT оплачивает такой выбор за токены, а не по подписке.',
        'routing.enabled': 'Отправлять предпочтения маршрутизации',
        'routing.enabled.hint': 'Выключено: ничего не отправляется, NanoGPT выбирает маршрут сам.',
        'routing.offNote': 'Маршрутизация выключена: настройки ниже сохраняются, но ничего не отправляется.',
        'routing.fixedRoute':
            'Модель работает по фиксированному маршруту: NanoGPT игнорирует настройки маршрутизации, отправляется только нулевое хранение данных.',
        'routing.needsSortNow': 'Желаемая задержка или скорость ничего не делают, пока не выбрана сортировка.',
        'routing.providers.placeholder': 'Введите id провайдера и нажмите Enter',
        'routing.providers.remove': 'Убрать {id}',
        'routing.field.noLimit': 'Без ограничения',
        'routing.disabled.subscriptionSafe':
            'Заблокировано: подключение работает только по подписке, и Nanovia убрала бы эту настройку. Чтобы ей пользоваться, смените режим оплаты.',

        'routing.field.order': 'Порядок провайдеров',
        'routing.field.order.hint': 'Провайдеры пробуются в этом порядке.',
        'routing.field.only': 'Только эти провайдеры',
        'routing.field.only.hint': 'Других провайдеров не будет, даже если эти не отвечают.',
        'routing.field.ignore': 'Никогда эти провайдеры',
        'routing.field.ignore.hint': 'Эти провайдеры пропускаются.',
        'routing.field.sort': 'Сортировка',
        'routing.sort.default': 'По умолчанию платформы',
        'routing.sort.price': 'Сначала дешёвые',
        'routing.sort.throughput': 'Наибольшая скорость',
        'routing.sort.latency': 'Наименьшая задержка',
        'routing.sort.speed': 'Скорость',
        'routing.field.sort.hint': 'Как ранжируются провайдеры-кандидаты.',
        'routing.field.quantizations': 'Допустимые точности',
        'routing.field.quantizations.hint': 'Только хосты, которые держат веса в одной из отмеченных точностей.',
        'routing.field.minQuantization': 'Минимальная точность',
        'routing.field.minQuantization.none': 'Без нижней границы',
        'routing.field.minQuantization.hint': 'Хосты с точностью ниже этой пропускаются.',
        'routing.field.maxPrice': 'Потолок цены (USD за 1 млн токенов)',
        'routing.field.maxPrice.prompt': 'Запрос',
        'routing.field.maxPrice.completion': 'Ответ',
        'routing.field.maxPrice.hint': 'Пусто означает «без потолка». Хосты дороже потолка пропускаются.',
        'routing.field.allowFallbacks': 'Разрешить запасные провайдеры',
        'routing.field.allowFallbacks.hint': 'Выключено: запрос завершится ошибкой, а не уйдёт к другому провайдеру.',
        'routing.field.requireParameters': 'Требовать поддержку параметров',
        'routing.field.requireParameters.hint': 'Только хосты, которые поддерживают все параметры запроса.',
        'routing.field.zdr': 'Только с нулевым хранением данных',
        'routing.field.zdr.hint': 'Только точки, которые не хранят копии ваших запросов.',
        'routing.field.zdr.keeps': 'Подписка сохраняется: это лишь сужает собственный выбор платформы.',
        'routing.field.preferredMaxLatency': 'Желаемая задержка (секунды)',
        'routing.field.preferredMaxLatency.hint': 'Нужна сортировка: это предпочтение, с которым она работает.',
        'routing.field.preferredMinThroughput': 'Желаемая скорость (токенов в секунду)',
        'routing.field.preferredMinThroughput.hint': 'Нужна сортировка: это предпочтение, с которым она работает.',
        'routing.field.cachingRoute': 'Маршрут с кешем запросов',
        'routing.field.cachingRoute.hint': 'Только провайдеры с кешем запросов; следующие запросы остаются на том же.',

        'routing.bypass.order':
            'Уводит из подписки: порядок провайдеров — явный выбор, оплата за токены плюс около {markup}%.',
        'routing.bypass.only':
            'Уводит из подписки: ограничение именованными провайдерами — оплата за токены плюс около {markup}%.',
        'routing.bypass.ignore':
            'Уводит из подписки: исключение провайдеров считается маршрутизацией, оплата за токены плюс около {markup}%.',
        'routing.bypass.sort':
            'Уводит из подписки: любая сортировка, кроме стандартной, — оплата за токены плюс около {markup}%.',
        'routing.bypass.quantizations':
            'Уводит из подписки: выбор точностей выбирает хосты, оплата за токены плюс около {markup}%.',
        'routing.bypass.minQuantization':
            'Уводит из подписки: нижняя граница точности выбирает хосты, оплата за токены плюс около {markup}%.',
        'routing.bypass.maxPrice':
            'Уводит из подписки: потолок цены выбирает хосты, оплата за токены плюс около {markup}%.',
        'routing.bypass.allowFallbacks':
            'Уводит из подписки, когда запасные провайдеры выключены: оплата за токены плюс около {markup}%.',
        'routing.bypass.requireParameters':
            'Уводит из подписки: требование параметров выбирает хосты, оплата за токены плюс около {markup}%.',
        'routing.bypass.preferredMaxLatency':
            'Уводит из подписки: предпочтение по задержке — маршрутизация, оплата за токены плюс около {markup}%.',
        'routing.bypass.preferredMinThroughput':
            'Уводит из подписки: предпочтение по скорости — маршрутизация, оплата за токены плюс около {markup}%.',
        'routing.bypass.cachingRoute':
            'Может увести из подписки: маршрут с кешем закрепляет хост (требует проверки вживую).',

        'routing.section.billing': 'Оплата',
        'routing.section.billing.hint': 'Остаются ли запросы внутри вашей подписки NanoGPT.',
        'routing.billing.mode': 'Режим оплаты',
        'routing.billing.auto': 'Автоматически',
        'routing.billing.subscription': 'Только подписка',
        'routing.billing.paygo': 'За токены',
        'routing.billing.auto.hint': 'Разрешены любые настройки; вердикт ниже показывает, что уводит из подписки.',
        'routing.billing.subscription.hint':
            'Настройки, которые оплачивались бы вне подписки, заблокированы, а Nanovia убирает их из каждого запроса. Нулевое хранение данных остаётся.',
        'routing.billing.paygo.hint': 'Всегда оплата за токены, что бы ни предлагала модель.',
        'routing.verdict.title': 'Вердикт',
        'routing.verdict.markup': 'наценка +{percent}%',
        'routing.verdict.safe': 'Из подписки ничего не уходит',
        'routing.verdict.safe.hint': 'Ни одна настройка этого подключения не обходит подписку.',
        'routing.verdict.modelUnknown':
            'Каталог пока не знает эту модель, поэтому итог — предположение. Он уточнится, когда каталог загрузится.',
        'routing.verdict.subscription': 'Запросы покрываются подпиской.',
        'routing.verdict.paygo': 'Запросы оплачиваются за токены.',
        'routing.verdict.unknown': 'По одним настройкам нельзя сказать, как оплатятся эти запросы.',
        'routing.verdict.stripped': 'Nanovia убирает эти настройки из каждого запроса: {fields}.',
        'routing.verdict.makeSafe': 'Убрать то, что уводит из подписки',
        'routing.verdict.makeSafe.hint':
            'Сбрасывает настройки, обходящие подписку, к нейтральным значениям; нулевое хранение данных остаётся.',

        'routing.section.reasoning': 'Рассуждения',
        'routing.reasoning.policy': 'Политика рассуждений',
        'routing.reasoning.follow': 'Как в запросе',
        'routing.reasoning.fixed': 'Фиксированный уровень',
        'routing.reasoning.off': 'Выключены',
        'routing.reasoning.default': 'По умолчанию модели',
        'routing.reasoning.follow.hint':
            'Берёт уровень, который запросил SillyTavern, и подгоняет под возможности модели. Фоновые задачи без уровня рассуждают как можно меньше.',
        'routing.reasoning.fixed.hint': 'Всегда уровень, выбранный ниже.',
        'routing.reasoning.off.hint':
            'Без рассуждений, если модель позволяет; если рассуждает всегда — самый низкий уровень со скрытым текстом.',
        'routing.reasoning.default.hint': 'Ничего не отправляется: решает модель.',
        'routing.reasoning.effort': 'Уровень',
        'routing.reasoning.effort.hint': 'Ограничен тем, что предлагает модель, если каталог её знает.',
        'routing.reasoning.hide': 'Не возвращать текст рассуждений в ответе',
        'routing.reasoning.hide.hint': 'Просит NanoGPT не присылать мысли (reasoning.exclude).',
        'routing.reasoning.caps.unknown':
            'Каталог не знает эту модель: уровни не ограничены и отправляются как запрошены.',
        'routing.reasoning.caps.none': 'Эта модель не рассуждает: настройки выше ни на что не влияют.',
        'routing.reasoning.caps.alwaysOn': 'Модель рассуждает всегда; выключить нельзя.',
        'routing.reasoning.caps.canDisable': 'Модель можно выключить.',
        'routing.reasoning.caps.efforts': 'Уровни: {efforts}.',
        'routing.reasoning.caps.noDial': 'Регулятора уровня нет, только вкл. и выкл.',
        'routing.preview.title': 'Что будет отправлено',
        'routing.preview.nothing': 'ничего, решает модель',
        'routing.preview.effort': 'уровень: {effort}',
        'routing.preview.off': 'рассуждения выключены',
        'routing.preview.on': 'рассуждения включены',
        'routing.preview.hidden': 'текст скрыт',
        'routing.preview.row.main': 'Чат, уровень не задан',
        'routing.preview.row.mainNone': 'Чат просит без рассуждений',
        'routing.preview.row.mainHigh': 'Чат просит высокий',
        'routing.preview.row.background': 'Фоновая задача',
    },
};
