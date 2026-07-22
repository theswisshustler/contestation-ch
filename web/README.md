# web/ — contestation.ch front-end

Front-end de `Contestation.dc.html` (importé depuis Claude Design), **câblé aux
Edge Functions Supabase**. Sans build ni framework.

## Fichiers

| Fichier            | Rôle |
|--------------------|------|
| `index.html`       | Coquille de page + markup du design embarqué dans `<template id="dc-template">`. |
| `support.js`       | Runtime du format `.dc` (`sc-if`, `sc-for`, `{{ }}`, `onClick`/`onInput`/`ref`). |
| `api.js`           | Client des Edge Functions (`window.API`). |
| `app.js`           | Logique d'écran + mapping état→`DossierContestation`. **Aucune règle métier** : tout est recalculé côté serveur. |
| `config.example.js`| Modèle de configuration à copier en `config.js`. |
| `config.js`        | Config runtime (URL + clé anon). **Gitignoré.** |

## Configuration

```bash
cp web/config.example.js web/config.js
# puis renseigner SUPABASE_URL et SUPABASE_ANON_KEY (clé « anon/public », jamais la service_role)
```

Le back-end est **requis** : sans `config.js` renseigné, l'app affiche un bandeau
d'erreur (plus de mode démo hors-ligne, plus de ruleset dupliqué côté front).

## Endpoints câblés

| Écran / action              | Edge Function        |
|-----------------------------|----------------------|
| Calculateur (landing)       | `evaluate-baisse`    |
| Import → analyse            | `extract-bail`       |
| Diagnostic                  | `evaluate`           |
| Aperçu (image filigranée)   | `generate-letter`    |
| Paiement                    | `create-checkout` (redirection Stripe) |
| Retour paiement `?session_id`/`?paid` | reprise via `localStorage` |
| Téléchargement (dashboard)  | `download-letter` (402 tant que non payé) |

L'upload d'import lit le PDF → base64 côté navigateur avant l'appel `extract-bail`.

## Lancer en local

```bash
# 1) back-end : soit un vrai projet Supabase (config.js), soit le mock de contrats :
node tools/mock-backend.mjs 8787       # puis pointer config.js sur http://localhost:8787
# 2) servir le front :
python3 -m http.server 8123 --directory web   # http://localhost:8123/index.html
```

`tools/mock-backend.mjs` reproduit les **contrats** des 6 fonctions (formes de
requête/réponse, CORS, verrou de paiement) — utile pour développer le front sans
projet live. Il n'implémente pas la logique juridique réelle.

## Déploiement

- **`APP_ORIGIN`** (variable des Edge Functions) doit valoir l'origine publique
  du front (ex. `https://contestation.ch`). Elle sert au CORS **et** de base aux
  URL de retour Stripe.
- **Pas de routing SPA à configurer.** `create-checkout` renvoie Stripe sur la
  racine avec un paramètre (`/?paid=1&session_id=…`, `/?dossier=…` en annulation)
  que l'app lit quel que soit le chemin. Tout hébergeur qui sert `index.html` sur
  `/` fonctionne (Vercel, Netlify, Cloudflare, Lovable, Replit…).

## Limites connues / suite

- **Signature (offre recommandée à 49,90 CHF)** : la signature est capturée côté client et incluse
  dans `DossierContestation.signatureDataUrl`, mais `generate-letter` lit le
  dossier déjà persisté (sans signature) et s'exécute à l'aperçu, avant la
  signature. Faire signer *avant* la génération, ou étendre `generate-letter`
  pour ré-injecter la signature, est un correctif back-end à part.
- **Numéro de suivi recommandé** (dashboard) : encore une valeur de maquette ;
  il faudra un endpoint de statut de dossier/envoi (Pingen) pour l'afficher.
- **Compte / connexion** (écran succès) : formulaire décoratif, pas encore
  branché — volontairement déféré à la plateforme (Lovable). Voir ci-dessous.

## Ajouter les comptes plus tard (ex. sur Lovable)

Le back-end est **déjà prêt** : `dossiers.user_id` (référence `auth.users`,
nullable pendant le parcours anonyme) et les policies RLS `dossiers_owner_select`
/ `mailings_owner_select`. Il ne reste qu'à brancher l'authentification :

1. **Activer Supabase Auth** — Dashboard → Authentication → Providers → Email.
   Pour créer le compte juste après paiement dans la même session, **désactiver
   la confirmation d'e-mail** (sinon pas de session immédiate).
2. **Inscription côté front** — sur l'écran succès, appeler
   `supabase.auth.signUp({ email, password })` (ou le REST `POST /auth/v1/signup`).
   On récupère un `access_token` (JWT).
3. **Rattacher le dossier au compte** — une petite Edge Function `claim-dossier`
   (service_role) qui, à partir du JWT (→ `auth.getUser()`) et du `dossierId`,
   fait `update dossiers set user_id = <uid> where id = <dossierId> and user_id is null`.
   Le client ne peut pas le faire directement (RLS), c'est voulu.
4. **Dashboard connecté (multi-appareils)** — pour retrouver ses dossiers plus
   tard, requêter `dossiers` avec le JWT (la policy owner autorise la lecture) ;
   le téléchargement du PDF passe toujours par `download-letter`. Prévoir un
   endpoint listant les lettres du dossier.

Lovable gère nativement l'auth Supabase : les étapes 1-2 y sont quasi
automatiques, et le tout se teste en live (impossible depuis l'environnement de
génération, dont le réseau est bloqué vers `*.supabase.co`).
