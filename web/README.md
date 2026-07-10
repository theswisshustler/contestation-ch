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

## Déploiement — à prévoir

- **Routing SPA** : Stripe redirige vers `APP_ORIGIN/merci?session_id=…` (et
  `APP_ORIGIN/apercu?dossier=…` en annulation). L'hébergement doit servir
  `index.html` pour ces chemins (fallback SPA), ou faire pointer `APP_ORIGIN`
  vers l'app. La reprise lit le paramètre de requête, pas le chemin.
- **CORS** : `APP_ORIGIN` (côté fonctions) doit correspondre à l'origine du front.

## Limites connues / suite

- **Signature (offre 35)** : la signature est capturée côté client et incluse
  dans `DossierContestation.signatureDataUrl`, mais `generate-letter` lit le
  dossier déjà persisté (sans signature) et s'exécute à l'aperçu, avant la
  signature. Faire signer *avant* la génération, ou étendre `generate-letter`
  pour ré-injecter la signature, est un correctif back-end à part.
- **Numéro de suivi recommandé** (dashboard) : encore une valeur de maquette ;
  il faudra un endpoint de statut de dossier/envoi (non existant) pour l'afficher.
- **Compte / connexion** (écran succès) : le formulaire est décoratif ; aucun
  flux d'authentification n'est branché (parcours anonyme).
