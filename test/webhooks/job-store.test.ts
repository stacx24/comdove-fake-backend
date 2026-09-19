import { MemoryJobStore } from '../../src/webhooks/job-store.js';
import { jobStoreContract } from './job-store.contract.js';

jobStoreContract('MemoryJobStore', () => new MemoryJobStore());
