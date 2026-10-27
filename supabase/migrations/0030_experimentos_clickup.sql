-- 0030: Link do documento de cada experimento no ClickUp (pedido do Pablo). Ao enviar a documentacao ao ClickUp, o Studio guarda o ID da pagina (para atualizar a
-- mesma pagina nos envios seguintes) e o endereco dela (que vai para a planilha do Google Sheets). Somente aditiva (ADD COLUMN, todas nulas).

alter table mkt.experimentos add column clickup_pagina_id text check (clickup_pagina_id is null or char_length(clickup_pagina_id) <= 60);
alter table mkt.experimentos add column clickup_url text check (clickup_url is null or char_length(clickup_url) <= 300);
alter table mkt.experimentos add column clickup_enviado_em timestamptz;
