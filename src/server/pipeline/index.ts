// The proxy pipeline (docs/ARCHITECTURE.md §4). A stage adds steps by appending one import and one array entry here;
// each step lives in its own file under steps/ (or next to the proxy, like the usage capture) and stays small.
import type { RequestStep, ResponseStep } from '../types';
import { usageStep } from '../usage-capture';
import { planStep } from './steps/plan';

/** Run in order before the upstream call. `planStep` goes first: it builds the plan the other steps refine. */
export const REQUEST_STEPS: RequestStep[] = [planStep];

/** Run once the upstream answer is complete. `usageStep` shims a whole body and completes the usage record. */
export const RESPONSE_STEPS: ResponseStep[] = [usageStep];
