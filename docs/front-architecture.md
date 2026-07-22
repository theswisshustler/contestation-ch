# Architecture front de Contestation.ch

## Vue d'ensemble

Le dépôt contient deux types de pages qui partagent le même déploiement Astro :

1. les pages de contenu (`/blog`, articles et `/admin`), rendues par Astro ;
2. le parcours locataire (`/` et `/diagnostic`), dont le balisage historique se
   trouve dans `web/index.html`.

Le parcours locataire conserve volontairement son HTML et ses styles existants.
Le changer en React, Vue ou Svelte obligerait à retranscrire plus d'un millier de
lignes de template et créerait un risque visuel sans bénéfice produit immédiat.
Le point instable n'était pas le template : c'était l'ancien algorithme qui
remplaçait tout le DOM après chaque modification.

## Cycle de rendu du parcours locataire

`web/support.js` comprend les primitives existantes (`sc-if`, `sc-for`,
interpolations, événements et refs). À chaque `setState` :

1. les changements d'état sont fusionnés synchroniquement ;
2. le brouillon est planifié ou sauvegardé immédiatement en cas de navigation ;
3. un seul rendu est planifié dans `requestAnimationFrame` ;
4. le DOM souhaité est construit dans un fragment hors écran ;
5. le runtime réconcilie ce fragment avec le DOM visible, nœud par nœud.

Les éléments contrôlés reçoivent une clé stable (`data-k`). Un input actif reste
donc le même objet DOM pendant la saisie. Les listeners sont mis à jour sans être
empilés. Les changements d'écran sont, eux, volontairement remplacés grâce à
`data-screen-label`.

## État et données utilisateur

`web/app.js` est l'unique propriétaire de l'état du parcours. Les handlers ne
modifient pas directement les propriétés imbriquées : ils passent par
`setState`, ce qui garantit rendu et persistance.

Le snapshot local inclut :

- le parcours, l'écran et l'étape ;
- tous les champs du dossier ;
- le résultat du diagnostic et les identifiants serveur ;
- l'offre choisie et, si nécessaire, la signature ;
- les métadonnées des documents importés.

Il exclut les loaders, erreurs temporaires, suggestions d'adresse et fonctions.
Une URL de preview trop ancienne est abandonnée et resignée par le backend.

## Persistance

`web/draft-store.js` sépare les données selon leur taille :

- `localStorage` pour le snapshot JSON du parcours ;
- `IndexedDB` pour les objets `File`/`Blob` des PDF.

Les champs sont synchronisés sur l'événement `input`, y compris lorsque le
template historique indique encore `onChange`. Le snapshot est sauvegardé après
120 ms d'inactivité, immédiatement lors d'un changement d'écran ou d'étape, et
une dernière fois sur `pagehide` ou lorsque l'onglet devient caché.

## Réseau et actions

`web/api.js` est le seul client des Edge Functions. Il impose un délai maximal
et normalise les erreurs réseau. Seule `generate-letter`, rendue idempotente côté
serveur, peut être rejouée automatiquement.

Les opérations à effet de bord possèdent un verrou synchrone : analyse,
diagnostic, génération, signature, checkout et téléchargement. La navigation du
questionnaire possède aussi un court verrou pour empêcher un double clic de
sauter une étape.

## Invariants à préserver

- Ne jamais réintroduire `mount.replaceChildren(...)` dans le runtime.
- Toute valeur utilisateur doit rejoindre l'état via `setState`/`setD`.
- Ne jamais mettre les PDF encodés en base64 dans `localStorage`.
- Ne pas rejouer automatiquement un POST non idempotent.
- Toute nouvelle ressource publique non hashée doit avoir une version dans son
  URL dans `web/index.html`.
- Le contenu, les styles et la logique métier juridique restent séparés : le
  frontend collecte et affiche, les Edge Functions recalculent.

## Validation

`src/front-runtime-resilience.test.ts` vérifie les invariants de code et la
persistance. `tools/front-smoke.mjs` pilote un vrai Chrome via le protocole CDP
pour vérifier les trois parcours, les clics, l'identité des champs, le reload,
IndexedDB, les routes légales et l'entrée directe `/diagnostic`.
