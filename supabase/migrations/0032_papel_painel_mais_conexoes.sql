-- 0032: O papel do painel (orq_panel) tinha limite de 5 conexoes simultaneas (0004), pensado para o Studio local. Com o Quark Dados publicado na Vercel,
-- cada instancia da funcao abre conexoes proprias (pelo pooler Supavisor, que as mantem ociosas por um tempo) e o limite estourava:
-- "too many connections for role orq_panel" (a aba Experimentos respondia internal_error). Sobe o limite para 15; o app tambem passou a usar no maximo
-- 2 conexoes por instancia e a soltar as ociosas em 10 s. Somente configuracao do papel: nenhuma tabela ou dado muda, e as permissoes continuam as mesmas.

alter role orq_panel connection limit 15;
