import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FORM_ID_RE, formSchema, type FormDef } from './form-schema.js';

export class StoreError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = 'StoreError';
  }
}

/** Formulários do Studio como arquivos JSON em uma pasta. Sem banco: é ambiente de testes local. */
export class FormsStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private file(id: string): string {
    if (!FORM_ID_RE.test(id)) throw new StoreError(`id inválido: ${id}`);
    return join(this.dir, `${id}.json`);
  }

  list(): Array<{ id: string; title: string; updated_at?: string; fields: number }> {
    const out: Array<{ id: string; title: string; updated_at?: string; fields: number }> = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      const parsed = formSchema.safeParse(this.read(join(this.dir, name)));
      if (parsed.success) out.push({ id: parsed.data.id, title: parsed.data.title, updated_at: parsed.data.updated_at, fields: parsed.data.fields.length });
    }
    return out.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
  }

  get(id: string): FormDef | null {
    const path = this.file(id);
    if (!existsSync(path)) return null;
    const parsed = formSchema.safeParse(this.read(path));
    return parsed.success ? parsed.data : null;
  }

  save(input: unknown): FormDef {
    const parsed = formSchema.safeParse(input);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'formulário'}: ${i.message}`);
      throw new StoreError('formulário inválido', issues);
    }
    const form: FormDef = { ...parsed.data, updated_at: new Date().toISOString() };
    const path = this.file(form.id);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(form, null, 2));
    renameSync(tmp, path);
    return form;
  }

  remove(id: string): void {
    const path = this.file(id);
    if (existsSync(path)) unlinkSync(path);
  }

  private read(path: string): unknown {
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return null;
    }
  }
}
