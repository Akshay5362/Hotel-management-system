import { defineConfig } from '@playwright/test';

export default defineConfig({
  // Directory where E2E tests are located
  testDir: './tests/e2e',
  
  // Timeout for each test in milliseconds (30 seconds)
  timeout: 30000,
  
  expect: {
    timeout: 5000,
  },
  
  // Disable parallel runs to prevent database session locking
  fullyParallel: false,
  workers: 1,
  
  // Use HTML reporter for visual report reviews
  reporter: [['html', { open: 'never' }]],
  
  use: {
    trace: 'on-first-retry',
  },
});
