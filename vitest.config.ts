import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Os testes de integração falam com o banco pela internet; 5 s (padrão) estoura em horário de rede lenta.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
