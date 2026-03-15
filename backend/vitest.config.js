import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 15000,
    hookTimeout: 30000,
    pool: 'forks',
    fileParallelism: false,
    include: ['test/**/*.test.js'],
    exclude: ['test/test_mqtt_logic.js'],
    globalSetup: ['test/helpers/globalSetup.js'],
    coverage: {
      provider: 'v8',
      include: ['src/routes/**', 'src/middleware/**', 'src/services/auth.js'],
    },
  },
});
