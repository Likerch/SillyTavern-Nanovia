// The feature registry (docs/ARCHITECTURE.md §5): a stage that adds a panel feature appends one import and one entry.
import type { Feature } from '../core/context';
import { connectionsFeature } from './connections';
import { routingFeature } from './routing';

export const FEATURES: Feature[] = [connectionsFeature, routingFeature];
