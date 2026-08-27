import { DemoBackend } from './demo.js';
import { describeOrderBackendContract } from './order-backend.contract.js';
import { makeDemoOrders } from './seed-orders.js';

describeOrderBackendContract('demo', async () => new DemoBackend(makeDemoOrders()));
