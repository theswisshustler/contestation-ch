# Edge Functions — contestation.ch

Fonctions Deno déployées sur Supabase, correspondant au workflow §5 du document
de travail.

## Flux (§5)

| Étape workflow | Function | Rôle |
|---|---|---|
| Manuel / import → JSON | `extract-bail` | PDF bail+formule → JSON (Claude API) |
| RULESET → motifs/éligibilité | `evaluate` | Recalcule le ruleset **côté serveur**, persiste le dossier |
| Calculateur gratuit | `evaluate-baisse` | Demande de baisse + capture lead |
| Génération lettre + preview | `generate-letter` | Gotenberg PDF **propre → bucket privé** ; PNG filigrané → preview |
| Paiement Stripe | `create-checkout` | Session Stripe Checkout (CHF, carte + TWINT) |
| Webhook suivi / déverrouillage | `stripe-webhook` | **Seul** point qui déverrouille + déclenche Pingen |
| PDF propre débloqué | `download-letter` | Gate de paiement → URL signée courte durée |
| Purge J+7 | `purge` | Rétention nLPD (DB + storage) |

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

Toute nouvelle fonction touchant `letters-clean` doit préserver 1–4.

## Déploiement

```bash
supabase db push                        # applique migrations/0001_init.sql
supabase functions deploy               # déploie toutes les fonctions
supabase secrets set --env-file supabase/functions/.env
```

Le webhook Stripe pointe sur `.../functions/v1/stripe-webhook`. Configurer le cron
de purge (pg_cron ou scheduler externe) pour POST quotidien sur `.../purge` avec
l'en-tête `x-purge-secret: $PURGE_SECRET`.
