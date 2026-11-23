// Strings of the shell: the drawer, the tab bar and the «General» tab.
import type { I18nParts } from '../core/types';

export const UI_STRINGS: I18nParts = {
    en: {
        'ui.title': 'Nanovia',
        'ui.tab.failed': 'This tab could not be shown. Details are in the browser console.',
        'ui.tab.general': 'General',
        'ui.general.about': 'NanoGPT as a first-class provider: connections, billing awareness and routing.',
        'ui.general.version': 'Version {version}',
        'ui.general.language': 'Interface language',
        'ui.general.language.auto': 'Follow SillyTavern',
        'ui.general.language.ru': 'Russian',
        'ui.general.language.en': 'English',
        'ui.general.debug': 'Debug logging',
        'ui.general.debugHint': 'Prints Nanovia details to the browser console. Keys and tokens are never printed.',
    },
    ru: {
        'ui.title': 'Nanovia',
        'ui.tab.failed': 'Эту вкладку не удалось показать. Подробности в консоли браузера.',
        'ui.tab.general': 'Общие',
        'ui.general.about': 'NanoGPT как полноценный провайдер: подключения, учёт тарифа и маршрутизация.',
        'ui.general.version': 'Версия {version}',
        'ui.general.language': 'Язык интерфейса',
        'ui.general.language.auto': 'Как в SillyTavern',
        'ui.general.language.ru': 'Русский',
        'ui.general.language.en': 'English',
        'ui.general.debug': 'Подробный журнал',
        'ui.general.debugHint':
            'Пишет подробности работы Nanovia в консоль браузера. Ключи и токены не выводятся никогда.',
    },
};
