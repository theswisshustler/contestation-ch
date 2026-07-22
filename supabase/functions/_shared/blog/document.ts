/**
 * Format canonique du blog contestation.ch.
 *
 * Ce module ne connaît ni Astro, ni Supabase, ni l'outil qui a produit le
 * contenu. Il constitue le contrat durable entre les adaptateurs d'entrée et
 * tous les renderers présents ou futurs.
 */

export type TextMark = 'bold' | 'italic' | 'code';

export type InlineNode =
  | { type: 'text'; text: string; marks?: TextMark[] }
  | { type: 'link'; href: string; children: InlineNode[] }
  | { type: 'break' };

export interface ParagraphBlock {
  type: 'paragraph';
  children: InlineNode[];
}

export interface HeadingBlock {
  type: 'heading';
  level: 2 | 3 | 4;
  id: string;
  children: InlineNode[];
}

export interface ListBlock {
  type: 'list';
  ordered: boolean;
  start?: number;
  items: Array<{ blocks: BlogBlock[] }>;
}

export interface QuoteBlock {
  type: 'quote';
  blocks: BlogBlock[];
  cite?: string;
}

export interface TableBlock {
  type: 'table';
  caption?: string;
  headers: InlineNode[][];
  rows: InlineNode[][][];
}

export interface ImageBlock {
  type: 'image';
  src: string;
  alt: string;
  caption?: string;
  credit?: string;
}

export interface FaqBlock {
  type: 'faq';
  items: Array<{
    id: string;
    question: string;
    answer: BlogBlock[];
  }>;
}

export interface CalloutBlock {
  type: 'callout';
  kind: 'information' | 'important' | 'example' | 'warning';
  title?: string;
  blocks: BlogBlock[];
}

export interface CtaBlock {
  type: 'cta';
  label: string;
  href: string;
  intent?: 'diagnostic' | 'initial-rent' | 'increase' | 'decrease' | 'secondary';
}

export interface CodeBlock {
  type: 'code';
  code: string;
  language?: string;
}

export type BlogBlock =
  | ParagraphBlock
  | HeadingBlock
  | ListBlock
  | QuoteBlock
  | TableBlock
  | ImageBlock
  | FaqBlock
  | CalloutBlock
  | CtaBlock
  | CodeBlock
  | { type: 'divider' };

export interface BlogDocumentV1 {
  schemaVersion: 1;
  locale: string;
  blocks: BlogBlock[];
}

export interface TocEntry {
  id: string;
  level: 2 | 3 | 4;
  label: string;
}

const DESIGN_KEYS = new Set([
  'style', 'styles', 'class', 'classname', 'css', 'color', 'background',
  'font', 'fontsize', 'textalign', 'align', 'spacing', 'margin', 'padding',
]);

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset',
  'figure', 'figcaption', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const DROP_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'canvas', 'template', 'noscript']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asText(value: unknown, max = 100_000): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function asChildren(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, '-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 90) || 'article';
}

export function sanitizeUrl(value: unknown, image = false): string {
  const raw = asText(value, 2_000);
  if (!raw) return '';
  if (raw.startsWith('/') || raw.startsWith('#')) return raw;
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:' || (!image && ['http:', 'mailto:', 'tel:'].includes(url.protocol))) {
      return url.toString();
    }
  } catch (_) {
    // Les URL relatives sans slash initial ne sont pas acceptées.
  }
  return '';
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function findForbiddenDesignKeys(value: unknown, path = '$'): string[] {
  const found: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => found.push(...findForbiddenDesignKeys(item, `${path}[${index}]`)));
  } else if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (DESIGN_KEYS.has(key.toLowerCase())) found.push(`${path}.${key}`);
      found.push(...findForbiddenDesignKeys(child, `${path}.${key}`));
    }
  }
  return found;
}

function normalizeMarks(value: unknown): TextMark[] | undefined {
  const marks = Array.isArray(value)
    ? value.filter((mark): mark is TextMark => mark === 'bold' || mark === 'italic' || mark === 'code')
    : [];
  return marks.length ? [...new Set(marks)] : undefined;
}

function normalizeInline(value: unknown): InlineNode | null {
  if (!isRecord(value)) return null;
  if (value.type === 'break') return { type: 'break' };
  if (value.type === 'text') {
    const text = typeof value.text === 'string' ? value.text : '';
    return text ? { type: 'text', text: text.slice(0, 100_000), marks: normalizeMarks(value.marks) } : null;
  }
  if (value.type === 'link') {
    const href = sanitizeUrl(value.href);
    const children = asChildren(value.children).map(normalizeInline).filter((node): node is InlineNode => !!node);
    return href && children.length ? { type: 'link', href, children } : null;
  }
  return null;
}

function inlineList(value: unknown): InlineNode[] {
  return asChildren(value).map(normalizeInline).filter((node): node is InlineNode => !!node);
}

function normalizeBlocks(value: unknown, depth = 0): BlogBlock[] {
  if (depth > 12) throw new Error('Document trop profondément imbriqué');
  return asChildren(value)
    .map((block) => normalizeBlock(block, depth))
    .filter((block): block is BlogBlock => !!block);
}

function normalizeBlock(value: unknown, depth: number): BlogBlock | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  switch (value.type) {
    case 'paragraph': {
      const children = inlineList(value.children);
      return children.length ? { type: 'paragraph', children } : null;
    }
    case 'heading': {
      const children = inlineList(value.children);
      const rawLevel = Number(value.level);
      const level = (rawLevel >= 4 ? 4 : rawLevel <= 2 ? 2 : 3) as 2 | 3 | 4;
      const id = slugify(asText(value.id) || inlineToText(children));
      return children.length ? { type: 'heading', level, id, children } : null;
    }
    case 'list': {
      const items = asChildren(value.items).map((item) => ({
        blocks: normalizeBlocks(isRecord(item) ? item.blocks : [], depth + 1),
      })).filter((item) => item.blocks.length);
      if (!items.length) return null;
      const start = Number(value.start);
      return {
        type: 'list', ordered: value.ordered === true,
        ...(Number.isInteger(start) && start > 1 ? { start } : {}), items,
      };
    }
    case 'quote': {
      const blocks = normalizeBlocks(value.blocks, depth + 1);
      return blocks.length ? { type: 'quote', blocks, ...(asText(value.cite) ? { cite: asText(value.cite, 300) } : {}) } : null;
    }
    case 'table': {
      const headers = asChildren(value.headers).map(inlineList);
      const rows = asChildren(value.rows).map((row) => asChildren(row).map(inlineList));
      return headers.length || rows.length
        ? { type: 'table', headers, rows, ...(asText(value.caption) ? { caption: asText(value.caption, 500) } : {}) }
        : null;
    }
    case 'image': {
      const src = sanitizeUrl(value.src, true);
      if (!src) return null;
      return {
        type: 'image', src, alt: asText(value.alt, 500),
        ...(asText(value.caption) ? { caption: asText(value.caption, 1_000) } : {}),
        ...(asText(value.credit) ? { credit: asText(value.credit, 500) } : {}),
      };
    }
    case 'faq': {
      const items = asChildren(value.items).map((item, index) => {
        const record = isRecord(item) ? item : {};
        const question = asText(record.question, 1_000);
        const answer = normalizeBlocks(record.answer, depth + 1);
        return { id: slugify(asText(record.id) || question || `question-${index + 1}`), question, answer };
      }).filter((item) => item.question && item.answer.length);
      return items.length ? { type: 'faq', items } : null;
    }
    case 'callout': {
      const blocks = normalizeBlocks(value.blocks, depth + 1);
      const allowed = ['information', 'important', 'example', 'warning'];
      const kind = allowed.includes(String(value.kind)) ? String(value.kind) as CalloutBlock['kind'] : 'information';
      return blocks.length ? { type: 'callout', kind, ...(asText(value.title) ? { title: asText(value.title, 300) } : {}), blocks } : null;
    }
    case 'cta': {
      const href = sanitizeUrl(value.href);
      const label = asText(value.label, 300);
      const intents = ['diagnostic', 'initial-rent', 'increase', 'decrease', 'secondary'];
      return href && label ? {
        type: 'cta', href, label,
        ...(intents.includes(String(value.intent)) ? { intent: String(value.intent) as CtaBlock['intent'] } : {}),
      } : null;
    }
    case 'code': {
      const code = typeof value.code === 'string' ? value.code.slice(0, 200_000) : '';
      return code ? { type: 'code', code, ...(asText(value.language) ? { language: asText(value.language, 40) } : {}) } : null;
    }
    case 'divider':
      return { type: 'divider' };
    default:
      return null;
  }
}

export function normalizeDocument(value: unknown, options: { rejectDesign?: boolean } = {}): BlogDocumentV1 {
  if (!isRecord(value)) throw new Error('Le document canonique doit être un objet JSON');
  if (options.rejectDesign !== false) {
    const forbidden = findForbiddenDesignKeys(value);
    if (forbidden.length) throw new Error(`Le contenu contient des informations de design interdites: ${forbidden.slice(0, 5).join(', ')}`);
  }
  const blocks = normalizeBlocks(value.blocks);
  if (!blocks.length) throw new Error('Le document ne contient aucun bloc publiable');
  return {
    schemaVersion: 1,
    locale: /^[a-z]{2}(?:-[A-Z]{2})?$/.test(asText(value.locale)) ? asText(value.locale) : 'fr-CH',
    blocks,
  };
}

export function inlineToText(nodes: InlineNode[]): string {
  return nodes.map((node) => node.type === 'text' ? node.text : node.type === 'break' ? '\n' : inlineToText(node.children)).join('');
}

export function documentToText(document: BlogDocumentV1): string {
  const walk = (blocks: BlogBlock[]): string[] => blocks.flatMap((block): string[] => {
    switch (block.type) {
      case 'paragraph': case 'heading': return [inlineToText(block.children)];
      case 'list': return block.items.flatMap((item) => walk(item.blocks));
      case 'quote': case 'callout': return walk(block.blocks);
      case 'table': return [...block.headers.map(inlineToText), ...block.rows.flat().map(inlineToText)];
      case 'image': return [block.alt, block.caption || ''].filter(Boolean);
      case 'faq': return block.items.flatMap((item) => [item.question, ...walk(item.answer)]);
      case 'cta': return [block.label];
      case 'code': return [block.code];
      default: return [];
    }
  });
  return walk(document.blocks).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function deriveExcerpt(document: BlogDocumentV1, max = 180): string {
  const text = documentToText(document).replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const clipped = text.slice(0, max + 1);
  const boundary = clipped.lastIndexOf(' ');
  return `${clipped.slice(0, boundary > max * 0.65 ? boundary : max).trim()}…`;
}

export function deriveToc(document: BlogDocumentV1): TocEntry[] {
  return document.blocks
    .filter((block): block is HeadingBlock => block.type === 'heading')
    .map((block) => ({ id: block.id, level: block.level, label: inlineToText(block.children) }));
}

export function estimateReadingMinutes(document: BlogDocumentV1): number {
  const words = documentToText(document).split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 220));
}

export function extractFaq(document: BlogDocumentV1): Array<{ question: string; answer: string }> {
  return document.blocks.flatMap((block) => block.type === 'faq'
    ? block.items.map((item) => ({ question: item.question, answer: walkText(item.answer) }))
    : []);
}

/**
 * Reconnaît la convention éditoriale la plus courante, quelle que soit la
 * source : un titre "FAQ/Questions fréquentes", puis une question par
 * sous-titre. L'information devient ainsi sémantique dans le document
 * canonique au lieu de dépendre du Markdown ou du HTML d'origine.
 */
export function promoteFaqSections(document: BlogDocumentV1): BlogDocumentV1 {
  const output: BlogBlock[] = [];
  const blocks = document.blocks;
  const isFaqTitle = (block: BlogBlock): block is HeadingBlock => block.type === 'heading'
    && /^(?:faq|foire aux questions|questions? (?:fr[eé]quentes?|courantes?))\s*[:?]?$/i
      .test(inlineToText(block.children).trim());

  for (let index = 0; index < blocks.length; index++) {
    const sectionTitle = blocks[index];
    if (!isFaqTitle(sectionTitle)) {
      output.push(sectionTitle);
      continue;
    }

    const items: FaqBlock['items'] = [];
    let cursor = index + 1;
    while (cursor < blocks.length) {
      const candidate = blocks[cursor];
      if (candidate.type === 'heading' && candidate.level <= sectionTitle.level) break;
      if (candidate.type !== 'heading') {
        cursor++;
        continue;
      }

      const question = inlineToText(candidate.children).trim();
      const answer: BlogBlock[] = [];
      cursor++;
      while (cursor < blocks.length) {
        const answerBlock = blocks[cursor];
        if (answerBlock.type === 'heading' && answerBlock.level <= candidate.level) break;
        answer.push(answerBlock);
        cursor++;
      }
      if (question && answer.length) items.push({ id: slugify(question), question, answer });
    }

    if (items.length) {
      output.push({ type: 'faq', items });
      index = cursor - 1;
    } else {
      output.push(sectionTitle);
    }
  }
  return { ...document, blocks: output };
}

function walkText(blocks: BlogBlock[]): string {
  return documentToText({ schemaVersion: 1, locale: 'fr-CH', blocks });
}

interface HtmlTextNode { kind: 'text'; text: string }
interface HtmlElementNode { kind: 'element'; tag: string; attrs: Record<string, string>; children: HtmlNode[] }
type HtmlNode = HtmlTextNode | HtmlElementNode;

function decodeHtml(value: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
    hellip: '…', laquo: '«', raquo: '»', rsquo: '’', lsquo: '‘', copy: '©', reg: '®',
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, entity: string) => {
    if (entity[0] === '#') {
      const hex = entity[1]?.toLowerCase() === 'x';
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return named[entity.toLowerCase()] ?? `&${entity};`;
  });
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const cleaned = raw.replace(/^\s*[^\s/>]+/, '');
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(cleaned))) {
    const key = match[1].toLowerCase();
    if (key.startsWith('on') || key === 'style' || key === 'class') continue;
    attrs[key] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

function parseHtmlTree(html: string): HtmlElementNode {
  const root: HtmlElementNode = { kind: 'element', tag: 'root', attrs: {}, children: [] };
  const stack: HtmlElementNode[] = [root];
  const tokens = html.slice(0, 2_000_000).match(/<!--[\s\S]*?-->|<![^>]*>|<\/?[^>]+>|[^<]+/g) ?? [];
  let dropped: string | null = null;
  let dropDepth = 0;
  for (const token of tokens) {
    if (token.startsWith('<!--') || token.startsWith('<!')) continue;
    if (token.startsWith('</')) {
      const tag = token.slice(2).match(/^\s*([a-z0-9-]+)/i)?.[1]?.toLowerCase() || '';
      if (dropped) {
        if (tag === dropped && --dropDepth <= 0) dropped = null;
        continue;
      }
      for (let index = stack.length - 1; index > 0; index--) {
        if (stack[index].tag === tag) { stack.length = index; break; }
      }
      continue;
    }
    if (token.startsWith('<')) {
      const tag = token.match(/^<\s*([a-z0-9-]+)/i)?.[1]?.toLowerCase() || '';
      if (!tag) continue;
      if (dropped) { if (tag === dropped) dropDepth++; continue; }
      if (DROP_TAGS.has(tag)) { dropped = tag; dropDepth = 1; continue; }
      const node: HtmlElementNode = { kind: 'element', tag, attrs: parseAttrs(token.slice(1, -1)), children: [] };
      stack[stack.length - 1].children.push(node);
      if (!VOID_TAGS.has(tag) && !token.endsWith('/>')) stack.push(node);
      continue;
    }
    if (!dropped) stack[stack.length - 1].children.push({ kind: 'text', text: decodeHtml(token) });
  }
  return root;
}

function htmlText(nodes: HtmlNode[]): string {
  return nodes.map((node) => node.kind === 'text' ? node.text : node.tag === 'br' ? '\n' : htmlText(node.children)).join('').replace(/\s+/g, ' ').trim();
}

function withMark(nodes: InlineNode[], mark: TextMark): InlineNode[] {
  return nodes.map((node): InlineNode => {
    if (node.type === 'text') return { ...node, marks: [...new Set([...(node.marks || []), mark])] };
    if (node.type === 'link') return { ...node, children: withMark(node.children, mark) };
    return node;
  });
}

function htmlInline(nodes: HtmlNode[]): InlineNode[] {
  const output: InlineNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'text') {
      if (node.text) output.push({ type: 'text', text: node.text });
      continue;
    }
    if (node.tag === 'br') { output.push({ type: 'break' }); continue; }
    if (node.tag === 'img') continue;
    let children = htmlInline(node.children);
    if (node.tag === 'strong' || node.tag === 'b') children = withMark(children, 'bold');
    if (node.tag === 'em' || node.tag === 'i') children = withMark(children, 'italic');
    if (node.tag === 'code') children = withMark(children, 'code');
    if (node.tag === 'a') {
      const href = sanitizeUrl(node.attrs.href);
      if (href && children.length) output.push({ type: 'link', href, children }); else output.push(...children);
    } else output.push(...children);
  }
  const compact: InlineNode[] = [];
  for (const node of output) {
    if (node.type === 'text') {
      const text = node.text.replace(/\s+/g, ' ');
      const previous = compact[compact.length - 1];
      if (previous?.type === 'text' && JSON.stringify(previous.marks || []) === JSON.stringify(node.marks || [])) previous.text += text;
      else if (text) compact.push({ ...node, text });
    } else compact.push(node);
  }
  return compact;
}

function imageFrom(node: HtmlElementNode): ImageBlock | null {
  const src = sanitizeUrl(node.attrs.src, true);
  return src ? { type: 'image', src, alt: asText(node.attrs.alt, 500), ...(node.attrs.title ? { caption: node.attrs.title.slice(0, 1_000) } : {}) } : null;
}

function elementBlocks(node: HtmlElementNode): BlogBlock[] {
  const tag = node.tag;
  if (tag === 'p') {
    const image = node.children.find((child): child is HtmlElementNode => child.kind === 'element' && child.tag === 'img');
    const inline = htmlInline(node.children);
    return [...(image ? [imageFrom(image)].filter((item): item is ImageBlock => !!item) : []), ...(inlineToText(inline).trim() ? [{ type: 'paragraph', children: inline } as ParagraphBlock] : [])];
  }
  if (/^h[1-6]$/.test(tag)) {
    const level = Math.min(4, Math.max(2, Number(tag[1]))) as 2 | 3 | 4;
    const children = htmlInline(node.children);
    return children.length ? [{ type: 'heading', level, id: slugify(node.attrs.id || inlineToText(children)), children }] : [];
  }
  if (tag === 'img') {
    const image = imageFrom(node);
    return image ? [image] : [];
  }
  if (tag === 'hr') return [{ type: 'divider' }];
  if (tag === 'pre') return [{ type: 'code', code: htmlText(node.children), ...(node.attrs['data-language'] ? { language: node.attrs['data-language'] } : {}) }];
  if (tag === 'ul' || tag === 'ol') {
    const items = node.children.filter((child): child is HtmlElementNode => child.kind === 'element' && child.tag === 'li')
      .map((li) => ({ blocks: nodesToBlocks(li.children) })).filter((item) => item.blocks.length);
    return items.length ? [{ type: 'list', ordered: tag === 'ol', items }] : [];
  }
  if (tag === 'blockquote') {
    const blocks = nodesToBlocks(node.children);
    return blocks.length ? [{ type: 'quote', blocks, ...(node.attrs.cite ? { cite: node.attrs.cite } : {}) }] : [];
  }
  if (tag === 'table') {
    const rows: Array<{ header: boolean; cells: InlineNode[][] }> = [];
    const visit = (children: HtmlNode[]) => children.forEach((child) => {
      if (child.kind !== 'element') return;
      if (child.tag === 'tr') {
        const cells = child.children.filter((cell): cell is HtmlElementNode => cell.kind === 'element' && (cell.tag === 'th' || cell.tag === 'td'));
        rows.push({ header: cells.some((cell) => cell.tag === 'th'), cells: cells.map((cell) => htmlInline(cell.children)) });
      } else visit(child.children);
    });
    visit(node.children);
    const headerIndex = rows.findIndex((row) => row.header);
    const headers = headerIndex >= 0 ? rows.splice(headerIndex, 1)[0].cells : [];
    return rows.length || headers.length ? [{ type: 'table', headers, rows: rows.map((row) => row.cells) }] : [];
  }
  if (tag === 'aside') {
    const rawKind = node.attrs['data-kind'] || node.attrs.role || 'information';
    const kind = ['important', 'example', 'warning'].includes(rawKind) ? rawKind as CalloutBlock['kind'] : 'information';
    const blocks = nodesToBlocks(node.children);
    return blocks.length ? [{ type: 'callout', kind, ...(node.attrs.title ? { title: node.attrs.title } : {}), blocks }] : [];
  }
  if (tag === 'a' && node.attrs['data-cta'] !== undefined) {
    const href = sanitizeUrl(node.attrs.href);
    const label = htmlText(node.children);
    return href && label ? [{ type: 'cta', href, label, intent: 'secondary' }] : [];
  }
  const nested = nodesToBlocks(node.children);
  if (nested.length) return nested;
  const inline = htmlInline(node.children);
  return inlineToText(inline).trim() ? [{ type: 'paragraph', children: inline }] : [];
}

function detailsToFaq(node: HtmlElementNode, index: number): FaqBlock['items'][number] | null {
  const summary = node.children.find((child): child is HtmlElementNode => child.kind === 'element' && child.tag === 'summary');
  const question = summary ? htmlText(summary.children) : '';
  const answerNodes = node.children.filter((child) => child !== summary);
  const answer = nodesToBlocks(answerNodes);
  return question && answer.length ? { id: slugify(question || `question-${index + 1}`), question, answer } : null;
}

function nodesToBlocks(nodes: HtmlNode[]): BlogBlock[] {
  const blocks: BlogBlock[] = [];
  let pendingInline: HtmlNode[] = [];
  let faqItems: FaqBlock['items'] = [];
  const flushInline = () => {
    const children = htmlInline(pendingInline);
    if (inlineToText(children).trim()) blocks.push({ type: 'paragraph', children });
    pendingInline = [];
  };
  const flushFaq = () => {
    if (faqItems.length) blocks.push({ type: 'faq', items: faqItems });
    faqItems = [];
  };
  nodes.forEach((node, index) => {
    if (node.kind === 'element' && node.tag === 'details') {
      flushInline();
      const item = detailsToFaq(node, index);
      if (item) faqItems.push(item);
      return;
    }
    if (node.kind === 'element' && BLOCK_TAGS.has(node.tag)) {
      flushInline(); flushFaq();
      blocks.push(...elementBlocks(node));
    } else {
      flushFaq();
      pendingInline.push(node);
    }
  });
  flushInline(); flushFaq();
  return blocks;
}

export function htmlToDocument(html: string, locale = 'fr-CH'): BlogDocumentV1 {
  const tree = parseHtmlTree(html);
  return promoteFaqSections(normalizeDocument({ schemaVersion: 1, locale, blocks: nodesToBlocks(tree.children) }, { rejectDesign: false }));
}

function tiptapInline(nodes: unknown): InlineNode[] {
  return asChildren(nodes).flatMap((raw): InlineNode[] => {
    if (!isRecord(raw)) return [];
    if (raw.type === 'hardBreak') return [{ type: 'break' }];
    if (raw.type === 'text') {
      const marks: TextMark[] = [];
      let href = '';
      asChildren(raw.marks).forEach((mark) => {
        if (!isRecord(mark)) return;
        if (mark.type === 'bold') marks.push('bold');
        if (mark.type === 'italic') marks.push('italic');
        if (mark.type === 'code') marks.push('code');
        if (mark.type === 'link' && isRecord(mark.attrs)) href = sanitizeUrl(mark.attrs.href);
      });
      const text: InlineNode = { type: 'text', text: String(raw.text || ''), ...(marks.length ? { marks: [...new Set(marks)] } : {}) };
      return href ? [{ type: 'link', href, children: [text] }] : [text];
    }
    return tiptapInline(raw.content);
  });
}

function tiptapBlocks(nodes: unknown): BlogBlock[] {
  return asChildren(nodes).flatMap((raw): BlogBlock[] => {
    if (!isRecord(raw)) return [];
    const attrs = isRecord(raw.attrs) ? raw.attrs : {};
    switch (raw.type) {
      case 'paragraph': return [{ type: 'paragraph', children: tiptapInline(raw.content) }];
      case 'heading': {
        const children = tiptapInline(raw.content);
        const level = Math.min(4, Math.max(2, Number(attrs.level) || 2)) as 2 | 3 | 4;
        return [{ type: 'heading', level, id: slugify(inlineToText(children)), children }];
      }
      case 'bulletList': case 'orderedList': return [{
        type: 'list', ordered: raw.type === 'orderedList',
        items: asChildren(raw.content).map((item) => ({ blocks: tiptapBlocks(isRecord(item) ? item.content : []) })),
      }];
      case 'blockquote': return [{ type: 'quote', blocks: tiptapBlocks(raw.content) }];
      case 'horizontalRule': return [{ type: 'divider' }];
      case 'image': {
        const src = sanitizeUrl(attrs.src, true);
        return src ? [{ type: 'image', src, alt: asText(attrs.alt), ...(asText(attrs.title) ? { caption: asText(attrs.title) } : {}) }] : [];
      }
      case 'codeBlock': return [{ type: 'code', code: asText(raw.content ? documentToText({ schemaVersion: 1, locale: 'fr-CH', blocks: tiptapBlocks(raw.content) }) : ''), ...(asText(attrs.language) ? { language: asText(attrs.language) } : {}) }];
      default: return tiptapBlocks(raw.content);
    }
  });
}

export function tiptapToDocument(value: unknown, locale = 'fr-CH'): BlogDocumentV1 {
  if (!isRecord(value) || value.type !== 'doc') throw new Error('Document Rich Text/Tiptap invalide');
  return promoteFaqSections(normalizeDocument({ schemaVersion: 1, locale, blocks: tiptapBlocks(value.content) }, { rejectDesign: false }));
}

function inlineToHtml(nodes: InlineNode[]): string {
  return nodes.map((node) => {
    if (node.type === 'break') return '<br>';
    if (node.type === 'link') return `<a href="${escapeHtml(node.href)}">${inlineToHtml(node.children)}</a>`;
    let text = escapeHtml(node.text);
    for (const mark of node.marks || []) {
      if (mark === 'bold') text = `<strong>${text}</strong>`;
      if (mark === 'italic') text = `<em>${text}</em>`;
      if (mark === 'code') text = `<code>${text}</code>`;
    }
    return text;
  }).join('');
}

export function documentToHtml(document: BlogDocumentV1): string {
  const blocks = (items: BlogBlock[]): string => items.map((block) => {
    switch (block.type) {
      case 'paragraph': return `<p>${inlineToHtml(block.children)}</p>`;
      case 'heading': return `<h${block.level} id="${escapeHtml(block.id)}">${inlineToHtml(block.children)}</h${block.level}>`;
      case 'list': return `<${block.ordered ? 'ol' : 'ul'}>${block.items.map((item) => `<li>${blocks(item.blocks)}</li>`).join('')}</${block.ordered ? 'ol' : 'ul'}>`;
      case 'quote': return `<blockquote>${blocks(block.blocks)}${block.cite ? `<cite>${escapeHtml(block.cite)}</cite>` : ''}</blockquote>`;
      case 'table': return `<table>${block.caption ? `<caption>${escapeHtml(block.caption)}</caption>` : ''}${block.headers.length ? `<thead><tr>${block.headers.map((cell) => `<th>${inlineToHtml(cell)}</th>`).join('')}</tr></thead>` : ''}<tbody>${block.rows.map((row) => `<tr>${row.map((cell) => `<td>${inlineToHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      case 'image': return `<figure><img src="${escapeHtml(block.src)}" alt="${escapeHtml(block.alt)}" loading="lazy">${block.caption ? `<figcaption>${escapeHtml(block.caption)}</figcaption>` : ''}</figure>`;
      case 'faq': return `<section>${block.items.map((item) => `<details><summary>${escapeHtml(item.question)}</summary>${blocks(item.answer)}</details>`).join('')}</section>`;
      case 'callout': return `<aside>${block.title ? `<strong>${escapeHtml(block.title)}</strong>` : ''}${blocks(block.blocks)}</aside>`;
      case 'cta': return `<p><a href="${escapeHtml(block.href)}">${escapeHtml(block.label)}</a></p>`;
      case 'code': return `<pre><code>${escapeHtml(block.code)}</code></pre>`;
      case 'divider': return '<hr>';
    }
  }).join('');
  return blocks(document.blocks);
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
