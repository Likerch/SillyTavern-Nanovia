// The «General» tab: the language of the interface and debug logging. Always the last tab of the panel.
import { UI_LANGUAGES } from '../core/settings';
import type { I18n, NanoviaSettings, SettingsService, TabDefinition } from '../core/types';
import { field, select, toggle } from './controls';
import type { SelectOption } from './controls';
import { el } from './dom';

export const GENERAL_TAB_ID = 'general';

export interface GeneralTabDeps {
    settings: SettingsService;
    i18n: I18n;
    version: string;
}

export function generalTab<Ctx>(deps: GeneralTabDeps): TabDefinition<Ctx> {
    const { settings, i18n, version } = deps;
    return {
        id: GENERAL_TAB_ID,
        titleKey: 'ui.tab.general',
        order: 1000,
        render(root) {
            const t = i18n.t.bind(i18n);
            const options: SelectOption<NanoviaSettings['uiLanguage']>[] = UI_LANGUAGES.map((value) => ({
                value,
                label: t(`ui.general.language.${value}`),
            }));
            root.append(
                el('div', { class: 'nanovia-muted', text: t('ui.general.about') }),
                el('div', { class: 'nanovia-muted', text: t('ui.general.version', { version }) }),
                el('div', { class: 'nanovia-group' }, [
                    field(
                        t('ui.general.language'),
                        select({
                            value: settings.get().uiLanguage,
                            options,
                            label: t('ui.general.language'),
                            onChange: (value) => settings.set('uiLanguage', value),
                        }),
                    ),
                    toggle({
                        label: t('ui.general.debug'),
                        hint: t('ui.general.debugHint'),
                        checked: settings.get().debug,
                        onChange: (checked) => settings.set('debug', checked),
                    }),
                ]),
            );
        },
    };
}
