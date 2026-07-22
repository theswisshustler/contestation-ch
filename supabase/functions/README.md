# Edge Functions — contestation.ch

Fonctions Deno déployées sur Supabase, correspondant au workflow §5 du document
de travail.

## Flux (§5)

| Étape workflow | Function | Rôle |
|---|---|---|
| Manuel / import → JSON | `extract-bail` | PDF bail+formule → JSON (Claude API) |
| RULESET → motifs/éligibilité | `evaluate` | Route vers loyer initial, hausse ou baisse, puis persiste le dossier |
| Calculateur gratuit | `evaluate-baisse` | Demande de baisse + capture lead |
| Génération lettre + preview | `generate-letter` | Gotenberg PDF **propre → bucket privé** ; PNG filigrané → preview |
| Signature recommandé | `sign-letter` | Régénère le PDF privé signé avant le checkout |
| Paiement Stripe | `create-checkout` | Session Stripe Checkout (CHF, carte + TWINT) |
| Webhook suivi / déverrouillage | `stripe-webhook` | **Seul** point qui déverrouille + déclenche Pingen |
| PDF propre débloqué | `download-letter` | Gate de paiement → URL signée courte durée |
| Purge J+7 | `purge` | Rétention nLPD (DB + storage) |

## Plateforme de publication

| Function | Rôle | Authentification |
|---|---|---|
| `blog-admin` | CRUD, auteurs, médias, aperçus et clés API | JWT Supabase + `blog_admins` |
| `blog-ingest` | Normalisation Markdown/HTML/Rich Text/JSON/API | JWT admin ou clé `cc_blog_…` |
| `blog-preview` | Lecture temporaire d’une révision non publiée | Jeton aléatoire à usage limité |

Le contrat canonique et le guide d’exploitation sont documentés dans
[`docs/blog-platform.md`](../../docs/blog-platform.md). Les tables éditoriales
ne sont jamais concernées par la purge J+7 des dossiers locatifs ; seuls les
jetons d’aperçu expirés sont retirés par `purge`.

## Invariant de sécurité (à ne jamais casser)

> **Le PDF propre n'est jamais exposé avant confirmation du paiement.**

Chaîne de garanties :

1. `generate-letter` écrit le PDF propre dans le bucket **privé** `letters-clean`
   et ne renvoie **que** des PNG filigranés (filigrane rastérisé, non retirable).
   `letters.unlocked` reste `false`.
2. Le bucket `letters-clean` n'a **aucune policy** pour `anon`/`authenticated` →
   inaccessible au client. Seul le `service_role` (Edge Functions) y accède.
3. `stripe-webhook` est le **seul** code qui passe `letters.unlocked = true`, et
   uniquement après `stripe.webhooks.constructEventAsync` (signature vérifiée).
4. `download-letter` refuse (`402`) tant que `unlocked !== true`, sinon émet une
   URL signée de 10 min.

`sign-letter` peut remplacer le PDF privé avant paiement, mais ne modifie jamais
`unlocked`. `create-checkout` vérifie que la lettre appartient au dossier,
que le dossier est éligible et que le recommandé possède une signature persistée.

Toute nouvelle fonction touchant `letters-clean` doit préserver 1–4.

## Déploiement

```bash
supabase db push                        # applique toutes les migrations, dont 0003 à 0005
supabase functions deploy               # déploie les fonctions appelées par le front
supabase functions deploy stripe-webhook --no-verify-jwt
supabase functions deploy blog-admin
supabase functions deploy blog-ingest --no-verify-jwt
supabase functions deploy blog-preview --no-verify-jwt
supabase functions deploy purge --no-verify-jwt
supabase secrets set --env-file supabase/functions/.env
```

Le webhook Stripe pointe sur `.../functions/v1/stripe-webhook`. Le flag
`--no-verify-jwt` est indispensable pour que Stripe puisse appeler cet endpoint;
la fonction vérifie elle-même la signature Stripe, le paiement interne, l'offre,
le montant, la devise et la relation dossier/lettre. Configurer ensuite le cron
de purge (pg_cron ou scheduler externe) pour POST quotidien sur `.../purge` avec
l'en-tête `x-purge-secret: $PURGE_SECRET`.
