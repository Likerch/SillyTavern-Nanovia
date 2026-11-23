// The feature registry (docs/ARCHITECTURE.md §5): a stage that adds a panel feature appends one import and one entry.
import type { Feature } from '../core/context';
import { accountFeature } from './account';
import { catalogFeature } from './catalog';
import { connectionsFeature } from './connections';
import { keysFeature } from './keys';
import { mgmtFeature } from './mgmt';
import { routingFeature } from './routing';

export const FEATURES: Feature[] = [
    connectionsFeature,
    catalogFeature,
    routingFeature,
    keysFeature,
    mgmtFeature,
    accountFeature,
];
