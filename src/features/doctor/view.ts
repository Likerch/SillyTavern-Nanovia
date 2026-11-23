// The «Diagnostics» tab: runs the checks of the whole setup when it opens (and on the button), lists the findings
// errors first and offers the one-click fix of each. All decisions (words, grouping, the fix label) are in view-model.ts;
// the service (core/doctor.ts) does the looking and the fixing; this file draws and keeps the tab in step with it.
import type { FeatureContext } from '../../core/context';
import { DOCTOR_LEVELS } from '../../domain/doctor';
import type { DoctorLevel } from '../../domain/doctor';
import { button, chip, clear, el } from '../../ui';
import { LEVEL_CHIP, fixFailureText, groupChecks, headline, summaryChips } from './view-model';
import type { CheckRow } from './view-model';

type NoticeKind = 'ok' | 'error';

export function renderDoctorTab(root: HTMLElement, ctx: FeatureContext): () => void {
    const { t, doctor } = ctx;
    const has = (key: string): boolean => ctx.i18n.has(key);
    let disposed = false;

    const headHost = el('div', { class: 'nanovia-doctor-head' });
    const noticeHost = el('div', { class: 'nanovia-notice-host', attrs: { 'aria-live': 'polite' } });
    const bodyHost = el('div', { class: 'nanovia-doctor-body' });
    root.append(headHost, noticeHost, bodyHost);

    function notify(kind: NoticeKind, text: string): void {
        clear(noticeHost);
        noticeHost.appendChild(el('div', { class: ['nanovia-notice', `nanovia-notice-${kind}`], text }));
    }

    /* ---------------------------------------------------------------------------------------------- drawing */

    function drawHead(): void {
        clear(headHost);
        const report = doctor.report();
        const running = doctor.running();
        const row = el('div', { class: 'nanovia-row' });
        if (report) {
            row.appendChild(el('b', { text: headline(report.summary, t) }));
            for (const spec of summaryChips(report.summary, t))
                row.appendChild(chip(spec.label, LEVEL_CHIP[spec.level]));
        }
        if (running) row.appendChild(el('span', { class: 'nanovia-muted', text: t('doctor.running') }));
        row.appendChild(
            button({
                label: t('doctor.run'),
                icon: 'stethoscope',
                kind: 'primary',
                disabled: running,
                onClick: async () => {
                    clear(noticeHost);
                    await doctor.run({ refresh: true });
                },
            }),
        );
        headHost.append(row, el('div', { class: 'nanovia-muted nanovia-doctor-hint', text: t('doctor.hint') }));
    }

    function drawRow(row: CheckRow): HTMLElement {
        const fix = row.fix;
        return el(
            'div',
            { class: ['nanovia-check', `nanovia-check-${row.level}`], data: { check: row.id, code: row.code } },
            [
                el('div', { class: 'nanovia-row nanovia-check-head' }, [
                    chip(t(`doctor.level.${row.level}`), LEVEL_CHIP[row.level]),
                    el('b', { class: 'nanovia-check-title', text: row.title }),
                ]),
                row.detail ? el('div', { class: 'nanovia-muted nanovia-check-detail', text: row.detail }) : null,
                fix
                    ? el('div', { class: 'nanovia-row nanovia-check-actions' }, [
                          button({
                              label: fix.label,
                              onClick: async () => {
                                  const result = await doctor.applyFix(fix.fix);
                                  if (disposed) return;
                                  if (!result.ok) notify('error', fixFailureText(result, t, has));
                                  else if (fix.fix.action !== 'open-tab') notify('ok', t('doctor.notice.fixed'));
                              },
                          }),
                      ])
                    : null,
            ],
        );
    }

    function drawGroup(level: DoctorLevel, rows: CheckRow[]): HTMLElement | null {
        if (rows.length === 0) return null;
        const title = `${t(`doctor.group.${level}`)} (${rows.length})`;
        if (level === 'ok') {
            // What passed is out of the way until asked for.
            return el('details', { class: 'nanovia-details nanovia-doctor-group nanovia-doctor-ok' }, [
                el('summary', { text: title }),
                el('div', { class: 'nanovia-check-list' }, rows.map(drawRow)),
            ]);
        }
        return el('section', { class: ['nanovia-doctor-group', `nanovia-doctor-${level}`] }, [
            el('div', { class: 'nanovia-doctor-group-title', text: title }),
            el('div', { class: 'nanovia-check-list' }, rows.map(drawRow)),
        ]);
    }

    function drawBody(): void {
        clear(bodyHost);
        const report = doctor.report();
        if (!report) {
            if (doctor.running())
                bodyHost.appendChild(el('div', { class: 'nanovia-muted', text: t('doctor.running') }));
            return;
        }
        const groups = groupChecks(report.checks, t, has);
        for (const level of DOCTOR_LEVELS) {
            const group = drawGroup(level, groups[level]);
            if (group) bodyHost.appendChild(group);
        }
    }

    function draw(): void {
        drawHead();
        drawBody();
    }

    /* ------------------------------------------------------------------------------------------------ wiring */

    const off = doctor.onChange(() => {
        if (!disposed) draw();
    });

    draw();
    // Opening the tab is asking for the checks.
    void doctor.run();

    return () => {
        disposed = true;
        off();
    };
}
