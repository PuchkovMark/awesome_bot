import { defineConfig } from 'vitest/config';
export default defineConfig({test:{environment:'node',include:['tests/load/**/*.test.ts'],maxWorkers:1,testTimeout:120000,hookTimeout:120000}});
