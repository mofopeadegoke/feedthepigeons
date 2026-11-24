import type { CreatePigeon } from '../contracts';
import { PigeonImpl } from './pigeon';

export const createPigeon: CreatePigeon = (opts) => new PigeonImpl(opts);
export { PigeonImpl };
