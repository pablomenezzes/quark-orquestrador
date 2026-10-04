import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FormsStore, StoreError } from '../studio/lib/forms-store';
import { formSchema } from '../studio/lib/form-schema';

let dir: string;
let store: FormsStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'studio-forms-'));
  store = new FormsStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const form = (over: Record<string, unknown> = {}) => ({
  id: 'demo',
  title: 'Demo',
  source_slug: 'lp-vercel-rh-teste',
  fields: [
    { id: 'f1', key: 'nome', type: 'text', label: 'Seu nome', required: true, map: 'name' },
    { id: 'f2', key: 'email', type: 'email', label: 'E-mail', required: true, map: 'email' },
  ],
  ...over,
});

describe('formSchema', () => {
  it('aplica padrões', () => {
    const f = formSchema.parse(form());
    expect(f).toMatchObject({ submit_label: 'Enviar', event_type: 'form_submit', show_consent: true });
    expect(f.fields[0]).toMatchObject({ options: [], placeholder: '', help: '' });
  });

  it('rejeita chaves repetidas, dois campos no mesmo destino e escolha sem opções', () => {
    const dupKey = form({ fields: [{ id: 'a', key: 'x', type: 'text', label: 'A' }, { id: 'b', key: 'x', type: 'text', label: 'B' }] });
    expect(formSchema.safeParse(dupKey).success).toBe(false);
    const dupMap = form({ fields: [{ id: 'a', key: 'a', type: 'email', label: 'A', map: 'email' }, { id: 'b', key: 'b', type: 'email', label: 'B', map: 'email' }] });
    expect(formSchema.safeParse(dupMap).success).toBe(false);
    const noOpt = form({ fields: [{ id: 'a', key: 'a', type: 'select', label: 'A', options: [] }] });
    expect(formSchema.safeParse(noOpt).success).toBe(false);
  });

  it('rejeita event_type que as fontes públicas não aceitam', () => {
    expect(formSchema.safeParse(form({ event_type: 'deal_ganho' })).success).toBe(false);
  });

  it('rejeita id inseguro', () => {
    for (const id of ['../x', 'A B', '', 'a/b', '.hidden', 'x'.repeat(80)]) expect(formSchema.safeParse(form({ id })).success).toBe(false);
  });
});

describe('FormsStore', () => {
  it('salva, lista, lê e apaga', () => {
    store.save(form());
    store.save(form({ id: 'outro', title: 'Outro' }));
    expect(store.list().map((f) => f.id).sort()).toEqual(['demo', 'outro']);
    expect(store.get('demo')?.title).toBe('Demo');
    expect(store.get('demo')?.updated_at).toBeTruthy();
    store.remove('demo');
    expect(store.get('demo')).toBeNull();
    expect(store.list().map((f) => f.id)).toEqual(['outro']);
  });

  it('regravar atualiza o conteúdo e o updated_at', async () => {
    const a = store.save(form());
    await new Promise((r) => setTimeout(r, 5));
    const b = store.save(form({ title: 'Novo título' }));
    expect(store.get('demo')?.title).toBe('Novo título');
    expect(b.updated_at! > a.updated_at!).toBe(true);
  });

  it('não escapa do diretório (path traversal) em get, save e remove', () => {
    expect(() => store.get('../segredo')).toThrow(StoreError);
    expect(() => store.remove('..\\x')).toThrow(StoreError);
    expect(() => store.save(form({ id: '../x' }))).toThrow(StoreError);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('save inválido lança StoreError com as mensagens e não grava nada', () => {
    try {
      store.save(form({ title: '' }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(StoreError);
      expect((e as StoreError).issues.length).toBeGreaterThan(0);
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it('arquivo corrompido é ignorado na listagem', async () => {
    store.save(form());
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'quebrado.json'), '{nao é json');
    expect(store.list().map((f) => f.id)).toEqual(['demo']);
  });

  it('não deixa arquivos temporários para trás', () => {
    store.save(form());
    expect(readdirSync(dir)).toEqual(['demo.json']);
  });
});
