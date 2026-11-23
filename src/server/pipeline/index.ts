// The proxy pipeline (docs/ARCHITECTURE.md §4). A stage adds steps by appending one import and one array entry here;
// each step lives in its own file under steps/ and stays small and pure where it can.
import type { RequestStep, ResponseStep } from '../types';
import { modelStep } from './steps/model';
import { stripSamplersStep } from './steps/strip-samplers';

/** Run in order before the upstream call. */
export const REQUEST_STEPS: RequestStep[] = [modelStep, stripSamplersStep];

/** Run once the upstream answer is complete. Empty in stage 0.1; usage and cost land here in stage 0.4. */
export const RESPONSE_STEPS: ResponseStep[] = [];
