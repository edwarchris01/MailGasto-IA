import { z } from 'zod';
import { categories } from './mail-rules.js';

export { categories, candidate, normalize, readModel, redact, resolveExtraction } from './mail-rules.js';
export type { NoticeText } from './mail-rules.js';
export const timezone = 'America/Bogota';
export const category = z.enum(categories);
export const statuses = z.enum(['processing', 'registered', 'pending', 'error']);
export const day = z.iso.date();
