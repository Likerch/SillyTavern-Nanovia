// What the Catalog tab remembers while the page is open (the panel draws a tab again every time it is selected): the
// filters, how many rows are drawn, the open model, and the numbers typed into the cost estimate and the host criteria.
// Nothing here is persisted: it is interface state, not a setting.
import { DEFAULT_COST_INPUTS, PAGE_SIZE, defaultFilters, defaultHostCriteria } from './view-model';
import type { CostInputs, FilterState, HostCriteriaState } from './view-model';

export interface CatalogSession {
    filters: FilterState;
    /** Rows drawn so far (grows by PAGE_SIZE with "show more", resets when a filter changes). */
    shown: number;
    /** Id of the model whose detail is open; null = the list. */
    selected: string | null;
    cost: CostInputs;
    hosts: HostCriteriaState;
}

export function createSession(): CatalogSession {
    return {
        filters: defaultFilters(),
        shown: PAGE_SIZE,
        selected: null,
        cost: { ...DEFAULT_COST_INPUTS },
        hosts: defaultHostCriteria(),
    };
}
