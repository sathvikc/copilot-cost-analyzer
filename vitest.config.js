import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Look for test files in src/ and tests/ directories
    include: ['src/**/*.test.js', 'tests/**/*.test.js'],
    // Use native Node.js environment (no jsdom needed for pure logic tests)
    environment: 'node',
    // Show detailed output for failed assertions
    reporters: ['default'],
    // Coverage settings (run with --coverage flag)
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js'],
      exclude: ['src/**/*.test.js', 'src/ui/**']
    }
  }
});
