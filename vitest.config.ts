import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Os testes de integração falam com o banco pela internet; 5 s (padrão) estoura em horário de rede lenta.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Os testes de integração usam os mesmos IDs fictícios (pipeline 940001, usuário 960001...) dentro de transações desfeitas:
    // dois arquivos ao mesmo tempo ficam esperando um pelo outro (trava de linha) até estourar o tempo. Um arquivo por vez.
    fileParallelism: false,
  },
});
