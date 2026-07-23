import { marked } from 'npm:marked@17.0.1';
import {
  escapeHtml,
  htmlToDocument,
  normalizeDocument,
  tiptapToDocument,
  type BlogDocumentV1,
} from './document.ts';

export const BLOG_INGESTION_FORMATS = new Set([
  'markdown', 'html', 'rich-text', 'canonical-v1', 'tiptap', 'json', 'plain',
]);

export function sourceAsString(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content) ?? '';
}

export async function convertBlogContent(
  format: string,
  content: unknown,
  locale: string,
): Promise<{ document: BlogDocumentV1; warnings: string[] }> {
  const warnings: string[] = [];
  if (format === 'canonical-v1') {
    const parsed = typeof content === 'string' ? JSON.parse(content) : content;
    return { document: normalizeDocument(parsed), warnings };
  }
  if (format === 'tiptap') {
    return {
      document: tiptapToDocument(typeof content === 'string' ? JSON.parse(content) : content, locale),
      warnings,
    };
  }
  if (format === 'json') {
    const parsed = typeof content === 'string' ? JSON.parse(content) : content;
    if (parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>).schemaVersion === 1) {
      return { document: normalizeDocument(parsed), warnings };
    }
    if (parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>).type === 'doc') {
      return { document: tiptapToDocument(parsed, locale), warnings };
    }
    throw new Error('JSON inconnu : indiquez canonical-v1 ou tiptap, ou ajoutez un adaptateur fournisseur');
  }

  const raw = String(content || '').slice(0, 2_000_000);
  if (!raw.trim()) throw new Error('Le contenu est vide');
  let html = raw;
  if (format === 'markdown') html = await marked.parse(raw, { gfm: true, breaks: false }) as string;
  if (format === 'plain') {
    html = raw.split(/\n{2,}/)
      .map((part) => `<p>${escapeHtml(part).replace(/\n/g, '<br>')}</p>`)
      .join('');
  }
  if (/<(?:style|script|iframe|object)\b|\s(?:style|class|on\w+)\s*=/i.test(html)) {
    warnings.push('Les styles, scripts et attributs de présentation ont été retirés du contenu importé.');
  }
  return { document: htmlToDocument(html, locale), warnings };
}
