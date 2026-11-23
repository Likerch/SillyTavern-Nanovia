// The feature registry (docs/ARCHITECTURE.md §5): a stage that adds a panel feature appends one import and one entry.
import type { Feature } from '../core/context';
import { accountFeature } from './account';
import { connectionsFeature } from './connections';
import { doctorFeature } from './doctor';
import { keysFeature } from './keys';
import { routingFeature } from './routing';

export const FEATURES: Feature[] = [connectionsFeature, routingFeature, keysFeature, accountFeature, doctorFeature];
