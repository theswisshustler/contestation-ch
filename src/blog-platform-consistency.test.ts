import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('plateforme de publication', () => {
  const migration = readFileSync('supabase/migrations/0005_blog_platform.sql', 'utf8');
  const home = readFileSync('web/index.html', 'utf8');
  const layout = readFileSync('src/layouts/BaseLayout.astro', 'utf8');
  const article = readFileSync('src/components/blog/ArticlePage.astro', 'utf8');
  const admin = readFileSync('src/pages/admin/index.astro', 'utf8');

  it('sépare révision de brouillon et révision publiée', () => {
    expect(migration).toContain('published_revision_id uuid');
    expect(migration).toContain('draft_revision_id     uuid');
    expect(migration).toContain('Les révisions du blog sont immuables');
  });

  it('n’expose au public que les articles publiés', () => {
    expect(migration).toContain("status = 'published' and published_at <= now()");
    expect(migration).toContain('security_invoker = true');
    expect(migration).toContain('alter table blog_revisions enable row level security');
  });

  it('génère les sorties SEO et éditoriales requises', () => {
    expect(layout).toContain('rel="canonical"');
    expect(layout).toContain('application/ld+json');
    expect(article).toContain("'@type': 'BlogPosting'");
    expect(article).toContain("'@type': 'FAQPage'");
    expect(readFileSync('src/pages/sitemap.xml.ts', 'utf8')).toContain('<urlset');
    expect(readFileSync('src/pages/rss.xml.ts', 'utf8')).toContain('<rss version="2.0"');
  });

  it('rend la Home compréhensible sans JavaScript et relie le blog', () => {
    expect(home).toContain('Contenu de secours pré-rendu');
    expect(home).toContain('href="/blog"');
    expect(home).toContain('href="/diagnostic?flow=loyer_initial"');
  });

  it('propose une récupération de mot de passe Supabase complète', () => {
    expect(admin).toContain('resetPasswordForEmail(email, { redirectTo: recoveryUrl })');
    expect(admin).toContain("event === 'PASSWORD_RECOVERY'");
    expect(admin).toContain('updateUser({ password })');
    expect(admin).toContain("new URL('/admin?mode=recovery', Astro.site");
    expect(admin).not.toContain('emailRedirectTo: `${location.origin}/admin`');
    expect(admin).toContain("error?.code === 'over_email_send_rate_limit'");
    expect(admin).toContain('startEmailCooldown(button)');
    expect(admin).toContain('Trop de liens ont été demandés en peu de temps.');
  });
});
