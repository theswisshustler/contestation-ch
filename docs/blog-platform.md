# Plateforme de publication intégrée

## Principe directeur

Le blog reçoit du contenu ; il ne dépend jamais de l’outil qui l’a écrit. Chaque
entrée suit la même chaîne :

```text
ChatGPT / Claude / Outrank / fichier / API / saisie manuelle
                            ↓
        adaptateur Markdown / HTML / Rich Text / JSON
                            ↓
             document canonique JSON versionné
                            ↓
          révision immuable + métadonnées éditoriales
                            ↓
        thème Astro / SEO / Schema.org / RSS / API
```

Le contenu canonique ne contient ni classes CSS, ni couleur, ni police, ni
espacement. Le normaliseur retire ces éléments des formats tolérants et refuse
leur présence dans un document `canonical-v1`.

## Format canonique

Le contrat se trouve dans
`supabase/functions/_shared/blog/document.ts`. Sa version actuelle est
`schemaVersion: 1`. Il prend en charge : paragraphes et marques inline, titres,
listes, citations, tableaux, images, FAQ, encadrés, CTA, code et séparateurs.

Une nouvelle source ne demande donc qu’un adaptateur vers ce contrat. Le schéma
de base, les pages publiques et le thème ne changent pas. Toute rupture future
doit créer une version du document et une migration explicite, jamais modifier
silencieusement le sens de la version 1.

Les FAQ sont détectées depuis :

- les blocs `faq` du JSON canonique ;
- les suites HTML `<details><summary>…` ;
- une section Markdown/HTML « FAQ » ou « Questions fréquentes », avec une
  question par sous-titre.

## Données et publication

- `blog_articles` porte l’état et les pointeurs de révision.
- `blog_revisions` conserve chaque version de façon immuable.
- `blog_ingestions` journalise la source, l’idempotence et les erreurs.
- `blog_authors`, `blog_topics` et `blog_media` portent les entités réutilisables.
- `blog_slug_history` garantit les redirections après changement d’URL.
- `blog_tombstones` permet une réponse HTTP 410 après suppression publique.
- `blog_preview_tokens` crée des aperçus privés, temporaires et non indexables.
- `blog_api_keys` stocke uniquement le hash des clés d’intégration.

Une modification de brouillon ne modifie jamais la version publique. Publier
consiste à faire pointer l’article vers une révision immuable. Une suppression
d’article publié le retire immédiatement du public, crée une tombstone HTTP 410
et conserve l’historique d’audit ; un brouillon jamais publié peut être supprimé
réellement.

## Administration

`/admin` utilise Supabase Auth et une liste d’autorisation `blog_admins` :

- `editor` : crée, importe, prévisualise et enregistre les brouillons ;
- `publisher` : mêmes droits, avec publication et archivage ;
- `owner` : mêmes droits, avec suppression et gestion des clés API.

Pour initialiser le premier propriétaire :

1. créer son utilisateur dans **Supabase → Authentication → Users** ;
2. exécuter dans le SQL Editor, en remplaçant l’adresse :

```sql
insert into public.blog_admins (user_id, role)
select id, 'owner'::public.blog_admin_role
from auth.users
where lower(email) = lower('vous@exemple.ch')
on conflict (user_id) do update set role = excluded.role;
```

Les imports, images, brouillons et publications passent tous par les fonctions
serveur. Le navigateur n’obtient jamais la `service_role`.

## Import par API

Un propriétaire crée une clé dans `/admin`, section **Intégrations API**. Elle
n’est affichée qu’une fois. L’outil externe envoie ensuite :

```http
POST https://xdyesbnjspixogzhnxrm.supabase.co/functions/v1/blog-ingest
Authorization: Bearer cc_blog_VOTRE_CLE
apikey: VOTRE_CLE_PUBLIABLE_SUPABASE
Content-Type: application/json
Idempotency-Key: article-fournisseur-123-v4
```

```json
{
  "format": "markdown",
  "intent": "draft",
  "source": {
    "provider": "outil-futur",
    "externalId": "article-123"
  },
  "metadata": {
    "title": "Contester une hausse de loyer",
    "topics": ["Hausse de loyer", "Délais"],
    "seoDescription": "Les étapes utiles pour examiner une hausse de loyer.",
    "sources": [
      { "label": "Office fédéral du logement", "url": "https://www.bwo.admin.ch/" }
    ]
  },
  "content": "## Comprendre la hausse\n\nVotre contenu…"
}
```

Formats : `markdown`, `html`, `plain`, `rich-text`, `tiptap`, `json` et
`canonical-v1`. `externalId` permet de retrouver le même article lors d’un
nouvel import ; `Idempotency-Key` empêche de rejouer accidentellement la même
requête. Une clé `articles:publish` peut demander `"intent": "publish"` ; par
défaut, toute intégration ne crée que des brouillons.

## Sorties automatiques

Pour chaque article publié, le site produit automatiquement : URL et slug,
canonical, titre et description SEO, Open Graph/Twitter, `BlogPosting`, fil
d’Ariane et FAQ Schema.org, table des matières, temps de lecture, articles liés,
page auteur et pages thématiques. Les sorties globales sont :

- `/sitemap.xml`
- `/rss.xml`
- `/robots.txt`
- `/api/blog/articles.json`

Les articles liés sont déterministes : thèmes communs, puis récence. Aucun appel
à un modèle IA n’est nécessaire au rendu ou à la publication.

## Déploiement

```bash
supabase db push
supabase functions deploy blog-admin
supabase functions deploy blog-ingest --no-verify-jwt
supabase functions deploy blog-preview --no-verify-jwt
supabase functions deploy purge --no-verify-jwt
```

`blog-ingest` est public au niveau de la passerelle uniquement pour accepter sa
clé API dédiée ; la fonction refuse toute requête sans JWT administrateur ou clé
`cc_blog_…` valide. Les jetons d’aperçu sont aléatoires, expirent et ne donnent
accès qu’à une révision. `blog-admin` reste protégé par JWT Supabase.

Le déploiement Replit doit ensuite utiliser `.replit` avec **Autoscale**. Après
publication, vérifier `/blog`, `/sitemap.xml`, `/rss.xml`, `/admin`, puis créer
le premier propriétaire avec la requête SQL ci-dessus.
