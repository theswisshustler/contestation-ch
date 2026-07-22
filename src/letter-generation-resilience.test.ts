import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('résilience de la génération de lettre', () => {
  const fn = readFileSync('supabase/functions/generate-letter/index.ts', 'utf8');
  const client = readFileSync('web/api.js', 'utf8');
  const migration = readFileSync(
    'supabase/migrations/0008_letter_generation_idempotency.sql',
    'utf8',
  );
  const fly = readFileSync('gotenberg/fly.toml', 'utf8');

  it('réutilise la lettre existante avant toute conversion', () => {
    expect(fn.indexOf('findExistingLetter(db, dossierId)')).toBeLessThan(
      fn.indexOf('ensureGotenbergReady()'),
    );
    expect(fn).toContain('letter_generation_reused');
  });

  it('interdit plusieurs lettres pour un même dossier', () => {
    expect(migration).toMatch(/unique index[\s\S]+letters \(dossier_id\)/i);
    expect(fn).toContain("lErr?.code === '23505'");
  });

  it('ne rejoue automatiquement que la génération idempotente', () => {
    expect(client).toContain('generateLetterWithRecovery');
    expect(client).toContain("if (!error || error.status !== 0) throw error");
    expect(client).not.toMatch(/createCheckout[^\n]+WithRecovery/);
  });

  it('garde une machine de rendu chaude et vérifie sa santé', () => {
    expect(fly).toContain('min_machines_running = 1');
    expect(fly).toContain('path = "/health"');
  });
});
