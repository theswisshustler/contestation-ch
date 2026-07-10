# contestation.ch — Fiche de reprise de session

> **À quoi sert ce fichier :** le ré-uploader dans une nouvelle conversation
> Claude Code (sur ta nouvelle machine) pour reprendre exactement où on s'est
> arrêtés. Il résume l'état du projet, les décisions prises, et surtout les
> **questions encore en suspens**.
>
> **Repo :** `theswisshustler/contestation-ch` · **Branche de travail :**
> `claude/contestation-dc-html-cgbixz` · Dernier commit : `f9ff6ae`.
> Date de la fiche : 2026-07-10.

---

## 1. Le projet en une phrase

**contestation.ch** : outil qui génère une lettre de contestation de loyer
initial (cantons de Vaud et Genève), avec calculateur d'éligibilité, parcours
manuel ou import de bail, paiement (5 CHF PDF / 35 CHF recommandé) et suivi.

## 2. Architecture (deux moitiés)

- **Front (`web/`)** — HTML/CSS/JS pur, **sans framework ni build**. Reproduit
  fidèlement le design importé depuis Claude Design (`Contestation.dc.html`).
  Fichiers : `index.html` (markup + design), `support.js` (mini-runtime qui rend
  le design), `api.js` (client des Edge Functions), `app.js` (logique d'écran +
  mapping des données), `config.js` (URL + clé, **gitignoré**).
- **Back-end (`supabase/`)** — Edge Functions Deno + Postgres. C'est **la valeur
  du produit** : ruleset juridique (`src/contestation-ruleset.ts`, testé, 40
  tests), génération sécurisée de la lettre, verrou de paiement. **Déjà construit
  et testé — à protéger, ne pas laisser un outil le régénérer.**
- **Services externes requis** par le back-end complet : **Stripe** (paiement),
  **Gotenberg** (HTML→PDF, à héberger), **Pingen** (envoi recommandé),
  **Anthropic** (lecture des baux à l'import).

## 3. Ce qui est FAIT (poussé sur la branche)

- ✅ Front implémenté à partir du design (commit `292e2c2`, **mergé** via PR #2).
- ✅ **Câblage front ↔ back** (commit `64c51b1`) : calcul→`evaluate-baisse`,
  import→`extract-bail` (vrai upload PDF), diagnostic→`evaluate`,
  aperçu→`generate-letter`, paiement→`create-checkout`, téléchargement→
  `download-letter`. Ruleset dupliqué supprimé du front (back = source de vérité).
  Vérifié bout-en-bout (17/17) contre un mock local (`tools/mock-backend.mjs`).
- ✅ **Retour Stripe host-agnostique** (commit `f9ff6ae`) : redirection sur la
  racine `/?paid=1` au lieu de `/merci` → aucun routing SPA à configurer.
- ✅ Doc à jour dans `web/README.md` (config, endpoints, déploiement, comptes).

## 4. Décisions déjà prises (ne pas re-débattre)

- Le **back-end est requis** (pas de mode démo hors-ligne ; pas de ruleset
  dupliqué côté front).
- **Vrai upload de fichiers** à l'import (PDF → base64 → `extract-bail`).
- Retour de paiement **sur la racine** avec paramètre de requête.
- **Compte / connexion : déféré** (voir §5.C). Le schéma le supporte déjà
  (`dossiers.user_id` + policies RLS).

## 5. QUESTIONS EN SUSPENS (le cœur de la reprise)

### A. Test live & déploiement du back-end ⬅️ **bloquant n°1**
- Test curl de `evaluate-baisse` → **HTTP 404** `"Requested function was not
  found"`. **URL et clé anon confirmées bonnes**, projet Supabase vivant, mais
  **les fonctions ne sont pas déployées** (et probablement le schéma non appliqué).
- **À faire (une fois)** via Supabase CLI :
  `supabase db push` (schéma) · `supabase functions deploy` (fonctions) ·
  `supabase secrets set --env-file supabase/functions/.env` (secrets).
  Cf. `supabase/functions/README.md` et `supabase/functions/.env.example`.
- Décision en attente : **comment déployer** — (a) je rédige un `DEPLOY.md`
  pas-à-pas, (b) on déploie ensemble juste `evaluate-baisse` pour voir un 200,
  (c) on fait tout au moment de Lovable. `evaluate-baisse` ne dépend d'aucun
  service externe → idéal pour un premier test vert.

### B. Choix de l'outil pour gérer/modifier le site ⬅️ **décision stratégique**
- Objectif de l'utilisateur : **piloter/modifier le site facilement** sans être
  technique. Envisagé : **Lovable**.
- Analyse : Lovable convient à l'objectif MAIS génère du **React** (il
  **reconstruira le front**, ne réutilise pas le HTML actuel) ; il faut
  **connecter** le back-end Supabase existant, **pas** le laisser le régénérer.
- Alternatives : **Replit** (garde le code exact, un peu plus technique) ;
  **Vercel/Netlify + Claude Code** (héberge le front tel quel, modifs via moi).
- **Question ouverte, non tranchée** : Lovable (piloter par chat, front refait
  en React) vs Replit/Vercel (garder l'ingénierie intacte) ?
- En attente : veux-tu une **« note de passage à Lovable »** (ce qu'il réutilise
  = back-end/API/design de référence ; ce qu'il reconstruit = front React ;
  check-list de déploiement) ?

### C. Compte / connexion (déféré, documenté)
- Déféré à Lovable (auth Supabase native, testable en live là-bas).
- Marche à suivre détaillée dans `web/README.md` § « Ajouter les comptes plus
  tard ». Schéma déjà prêt ; il manque : activer Supabase Auth (sans
  confirmation e-mail), inscription front, petite fonction `claim-dossier`.

### D. Correctifs back-end connus (pas encore faits)
- **Signature (offre 35)** : elle est capturée côté client mais `generate-letter`
  tourne à l'aperçu, **avant** la signature → la signature n'atteint pas le PDF.
  Corriger l'ordre, ou étendre `generate-letter`.
- **Numéro de suivi** (dashboard) : encore une valeur de maquette ; nécessite un
  endpoint de statut Pingen.

### E. Pull request
- La branche `claude/contestation-dc-html-cgbixz` porte le câblage (2 commits
  au-dessus de `main`) — **PR pas encore ouverte**. À faire quand tu veux.

## 6. Config (valeurs publiques par conception)

Sur la nouvelle machine, recréer `web/config.js` (gitignoré) :
```js
window.CONTESTATION_CONFIG = {
  SUPABASE_URL: 'https://xdyesbnjspixogzhnxrm.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_nxDs_m7JYXHjbvNbHmJZpA_0szaiTay',
};
```
> La clé `anon`/publishable est **publique** (protégée par les RLS + recalcul
> serveur). Ne **jamais** mettre ici la `service_role`.

## 7. Comment relancer en local (rappel)

```bash
# back-end factice (contrats only) pour développer le front sans Supabase :
node tools/mock-backend.mjs 8787      # puis config.js -> http://localhost:8787
# servir le front :
python3 -m http.server 8123 --directory web   # http://localhost:8123/index.html
```
Test rapide du vrai back-end (une fois déployé) :
```bash
curl -i -X POST -H "content-type: application/json" \
  -H "apikey: sb_publishable_nxDs_m7JYXHjbvNbHmJZpA_0szaiTay" \
  -H "authorization: Bearer sb_publishable_nxDs_m7JYXHjbvNbHmJZpA_0szaiTay" \
  -d '{"loyerNetMensuel":1980,"tauxReferenceBail":1.75}' \
  https://xdyesbnjspixogzhnxrm.supabase.co/functions/v1/evaluate-baisse
# attendu une fois déployé : HTTP 200 + {"result":{"eligible":true,...}}
```

## 8. Prochaines actions suggérées (par ordre)

1. **Trancher l'outil** (§5.B) : Lovable vs Replit vs Vercel+Claude.
2. **Déployer le back-end** (§5.A) : au minimum `evaluate-baisse` pour un test
   vert, puis le reste + services externes.
3. (Selon 1) **Note de passage à Lovable** si tu pars sur Lovable.
4. **Ouvrir la PR** du câblage (§5.E).
5. Correctifs back-end §5.D quand le déploiement est en place.

---

### Message à coller à Claude sur la nouvelle machine
> « Reprends le projet contestation.ch. Voici la fiche de reprise (REPRISE.md).
> On en était aux questions en suspens : choix de l'outil (Lovable vs Replit),
> déploiement du back-end Supabase (les fonctions renvoient 404 = non déployées),
> et l'ouverture de la PR. Aide-moi à avancer. »
