// Route modules of the admin API under /api/plugins/nanovia. A stage appends its module here.
import type { RouteModule } from '../types';
import { catalogRoutes } from './catalog';
import { connectionRoutes } from './connections';
import { keyRoutes } from './keys';
import { statusRoutes } from './status';

export const ROUTE_MODULES: RouteModule[] = [statusRoutes, connectionRoutes, keyRoutes, catalogRoutes];
