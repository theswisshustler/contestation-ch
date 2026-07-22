# contestation.ch

Application de contestation de loyers et plateforme de publication intégrée.
Le front est rendu par Astro en mode serveur ; les données, paiements, lettres et
articles sont gérés par Supabase Edge Functions.

## Développement local

Prérequis : Node.js 20+ et Corepack.

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm dev --host 0.0.0.0 --port 5000
```

Vérifications avant livraison :

```bash
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
```

Le site est disponible sur `http://localhost:5000`, le blog sur `/blog` et
l’administration privée sur `/admin`.

## Plateforme de publication

Le blog n’est pas lié à un CMS ou à un fournisseur de contenu. Markdown, HTML,
texte, Tiptap, Rich Text ou JSON sont convertis vers un document JSON canonique
versionné. Astro est le seul responsable du design et du rendu.

Architecture, contrat d’import, initialisation d’un administrateur et procédure
de déploiement : [docs/blog-platform.md](docs/blog-platform.md).

Configuration et invariants des fonctions :
[supabase/functions/README.md](supabase/functions/README.md).

## Déploiement du front

Le fichier `.replit` construit l’adaptateur Node d’Astro et lance le serveur
`dist/server/entry.mjs`. Le déploiement Replit doit être de type Autoscale, et
non Static, car les pages du blog, le sitemap et le RSS sont rendus côté serveur.

Variables publiques facultatives (des valeurs de production non secrètes sont
prévues par défaut) :

```dotenv
PUBLIC_SUPABASE_URL=https://votre-projet.supabase.co
PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```
