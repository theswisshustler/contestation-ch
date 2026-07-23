import { describe, expect, it } from 'vitest';
import type { PublicBlogArticle } from './lib/blog.ts';
import { buildSitemapEntries, renderSitemap } from './pages/sitemap.xml.ts';

function article(overrides: Partial<PublicBlogArticle>): PublicBlogArticle {
  return {
    slug: 'contester-son-loyer',
    updated_at: '2026-07-20T10:00:00.000Z',
    author_slug: 'equipe-contestation',
    topics: [{ name: 'Loyer initial', slug: 'loyer-initial' }],
    ...overrides,
  } as PublicBlogArticle;
}

describe('sitemap', () => {
  it('discovers articles, categories and authors from published content', () => {
    const entries = buildSitemapEntries([
      article({}),
      article({
        slug: 'demande-de-baisse',
        updated_at: '2026-07-22T12:00:00.000Z',
        topics: [
          { name: 'Loyer initial', slug: 'loyer-initial' },
          { name: 'Baisse de loyer', slug: 'baisse-de-loyer' },
        ],
      }),
    ]);

    expect(entries).toContainEqual({
      loc: 'https://contestation.ch/blog/demande-de-baisse',
      lastmod: '2026-07-22T12:00:00.000Z',
    });
    expect(entries.filter(({ loc }) => loc.endsWith('/categorie/loyer-initial'))).toEqual([{
      loc: 'https://contestation.ch/blog/categorie/loyer-initial',
      lastmod: '2026-07-22T12:00:00.000Z',
    }]);
    expect(entries.filter(({ loc }) => loc.endsWith('/auteur/equipe-contestation'))).toHaveLength(1);
    expect(entries.find(({ loc }) => loc === 'https://contestation.ch/blog')?.lastmod)
      .toBe('2026-07-22T12:00:00.000Z');
  });

  it('always produces a valid sitemap for the fixed public pages', () => {
    const xml = renderSitemap(buildSitemapEntries([]));

    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain('<loc>https://contestation.ch/</loc>');
    expect(xml).toContain('<loc>https://contestation.ch/diagnostic</loc>');
    expect(xml).toContain('<loc>https://contestation.ch/blog</loc>');
  });

  it('omits an invalid last modification date instead of throwing', () => {
    expect(renderSitemap([{ loc: 'https://contestation.ch/blog/test', lastmod: 'invalid' }]))
      .toContain('<url><loc>https://contestation.ch/blog/test</loc></url>');
  });
});
