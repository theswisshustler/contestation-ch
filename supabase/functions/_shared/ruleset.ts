// Source unique de vérité : le ruleset testé unitairement vit dans /src.
// Les Edge Functions le ré-exportent d'ici pour recalculer côté serveur
// (ne jamais faire confiance à une évaluation venue du client).
export * from '../../../src/contestation-ruleset.ts';
