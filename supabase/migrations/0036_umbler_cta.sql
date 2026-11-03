-- 0036: guarda qual botao (CTA) o lead clicou depois de cada template. So o TEXTO DO BOTAO, que e definido pelo template
-- (ex.: "Quero retomar com 20%OFF", "Nao tenho interesse"); respostas em texto livre nao sao guardadas.
-- Somente aditiva (ADD COLUMN). Nada em public, core, orq, crm, raw nem mkt.

alter table ops.umbler_mensagem add column cta text;
