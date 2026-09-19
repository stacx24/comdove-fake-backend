// The one lock table for the whole process: the /ws sessions take it and Person 2's
// registry reads it (launch-page free/locked, claim status, 409 on delete) (FR-09, FR-16).
import { createLockTable } from './lock.js';

export const sharedLock = createLockTable();
