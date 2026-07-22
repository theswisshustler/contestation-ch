import { describe, expect, it } from 'vitest';
import {
  deriveExcerpt,
  deriveToc,
  documentToHtml,
  extractFaq,
  htmlToDocument,
  normalizeDocument,
  slugify,
  tiptapToDocument,
} from '../supabase/functions/_shared/blog/document.ts';

describe('document canonique du blog', () => {
  it('supprime scripts et informations de design lors d’un import HTML', () => {
    const document = htmlToDocument(`
      <style>body{background:red}</style><script>alert(1)</script>
      <h1 style="color:red" class="hero">Titre importé</h1>
      <p onclick="evil()">Texte <strong>important</strong>.</p>
    `);
    const serialized = JSON.stringify(document);
    expect(serialized).not.toContain('alert');
    expect(serialized).not.toContain('color');
    expect(serialized).not.toContain('hero');
    expect(document.blocks[0]).toMatchObject({ type: 'heading', level: 2, id: 'titre-importe' });
  });

  it('refuse le design injecté dans un document canonical-v1', () => {
    expect(() => normalizeDocument({
      schemaVersion: 1,
      locale: 'fr-CH',
      blocks: [{ type: 'paragraph', style: 'color:red', children: [{ type: 'text', text: 'Texte' }] }],
    })).toThrow(/design interdites/);
  });

  it('convertit tableaux et FAQ vers des blocs sémantiques', () => {
    const document = htmlToDocument(`
      <table><thead><tr><th>Délai</th><th>Action</th></tr></thead><tbody><tr><td>30 jours</td><td>Contester</td></tr></tbody></table>
      <details><summary>Puis-je agir ?</summary><p>Oui, si le délai court encore.</p></details>
    `);
    expect(document.blocks.map((block) => block.type)).toEqual(['table', 'faq']);
    expect(extractFaq(document)).toEqual([{ question: 'Puis-je agir ?', answer: 'Oui, si le délai court encore.' }]);
  });

  it('reconnaît automatiquement une section FAQ issue de Markdown', () => {
    const document = htmlToDocument(`
      <h2>Questions fréquentes</h2>
      <h3>Quel est le délai ?</h3><p>Le délai est de 30 jours.</p>
      <h3>Quels documents préparer ?</h3><p>Le bail et la formule officielle.</p>
      <h2>Conclusion</h2><p>Vous pouvez maintenant agir.</p>
    `);
    expect(document.blocks.map((block) => block.type)).toEqual(['faq', 'heading', 'paragraph']);
    expect(extractFaq(document)).toEqual([
      { question: 'Quel est le délai ?', answer: 'Le délai est de 30 jours.' },
      { question: 'Quels documents préparer ?', answer: 'Le bail et la formule officielle.' },
    ]);
  });

  it('normalise un Rich Text Tiptap sans dépendre de son renderer', () => {
    const document = tiptapToDocument({ type: 'doc', content: [
      { type: 'heading', attrs: { level: 2, textAlign: 'center' }, content: [{ type: 'text', text: 'Mon titre' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Un lien', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] }] },
    ] });
    expect(document.blocks[0]).toMatchObject({ type: 'heading', id: 'mon-titre' });
    expect(JSON.stringify(document)).not.toContain('textAlign');
  });

  it('dérive le sommaire et un extrait sans fournisseur IA', () => {
    const document = htmlToDocument('<h2>Comprendre le calcul</h2><p>Cette explication présente les éléments utiles au locataire.</p>');
    expect(deriveToc(document)).toEqual([{ id: 'comprendre-le-calcul', level: 2, label: 'Comprendre le calcul' }]);
    expect(deriveExcerpt(document)).toContain('Comprendre le calcul');
  });

  it('échappe toujours le HTML dans le rendu secondaire RSS', () => {
    const document = normalizeDocument({ schemaVersion: 1, locale: 'fr-CH', blocks: [
      { type: 'paragraph', children: [{ type: 'text', text: '<img src=x onerror=alert(1)>' }] },
    ] });
    expect(documentToHtml(document)).toContain('&lt;img');
    expect(documentToHtml(document)).not.toContain('<img src=x');
  });

  it('génère des slugs français stables', () => {
    expect(slugify("L’augmentation du loyer à Genève")).toBe('l-augmentation-du-loyer-a-geneve');
  });
});
