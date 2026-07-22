# contestation.ch — Document de travail

**Version 1.0 — Base pour build (Claude Code / Claude Design → handover Lovable)**
Périmètre MVP : loyer initial abusif, cantons VD + GE, habitation, français.

---

## 1. Résumé exécutif & thèse produit

contestation.ch génère automatiquement une **requête en contestation de loyer initial** adressée à la bonne autorité de conciliation, à partir soit d'un import du bail (+ formule officielle), soit d'un flux de questions manuel.

**La thèse commerciale et juridique (à garder en tête partout) :** l'outil ne « prouve » pas que le loyer est abusif — il n'en a pas les moyens (les chiffres sont chez le bailleur). Il **installe un doute sérieux, renverse le fardeau de la preuve sur le bailleur, et crée une pression de règlement à l'amiable**. La très grande majorité des dossiers se règlent en conciliation, sans procès public : le bailleur préfère souvent concéder une baisse plutôt que d'ouvrir sa comptabilité. C'est exactement l'effet recherché.

**Deux offres :**
- **14,90 CHF** — lettre personnalisée finalisée, checklist des pièces, PDF à imprimer et envoyer soi-même.
- **49,90 CHF** — même contenu, puis impression et envoi en recommandé pour le locataire (via Pingen).

**Produit d'appel gratuit :** un calculateur « ai-je droit à une baisse de loyer ? » basé sur le taux de référence, pour capter l'email et alimenter le funnel.

---

## 2. Périmètre & décisions actées (MVP)

| Sujet | Décision |
|---|---|
| Marque | contestation.ch (pas d'infos perso, structure juridique plus tard) |
| Public | B2C uniquement |
| Cantons | Vaud + Genève |
| Cas traité | Loyer initial (+ calculateur baisse gratuit) |
| Type d'objet | Habitation uniquement |
| Langue | Français seul |
| Flux | Import bail **et** flux manuel dès le MVP |
| Prix | 14,90 CHF (impression soi-même) / 49,90 CHF (recommandé) |
| Objectif | ~10 contestations/mois |
| Compte | Parcours sans compte ; création de compte **après paiement** pour le suivi |
| Signature | Signature dessinée capturée dans l'UI (nécessaire pour le recommandé) |
| Rétention données | Suppression de **toutes** les données après **7 jours** |
| Hébergement | En Suisse (voir §7, point à arbitrer) |
| Extraction | Claude API |
| Paiement | Stripe (société Stripe), TWINT si dispo direct |
| Recommandé | Pingen ; expéditeur = le locataire |
| Échec génération | Notification à l'exploitant → traitement manuel |
| Responsabilité | **Aucune** ; outil d'aide uniquement. Gros disclaimer + renvoi ASLOCA pour cas complexes |
| RC pro / partenariat ASLOCA / relecture juridique | Non (choix assumé — voir §11 Risques) |
| Budget setup | ~50 CHF (domaine + tiers gratuits) |
| Go-to-market | Facebook Ads + SEO |
| Lancement | ASAP (voir §10 pour le séquencement réaliste) |

---

## 3. Socle juridique opérationnel (loyer initial)

### 3.1 Base légale
- **Art. 270 CO** : contestation du loyer initial devant l'autorité de conciliation, dans les **30 jours dès la remise des clés** (= entrée en jouissance, PAS le 1er versement).
- **Art. 269 CO** : un loyer est abusif s'il procure au bailleur un **rendement net excessif** des fonds propres investis (critère « reine »).
- **Art. 269a CO** : exceptions (loyers usuels du quartier let. a ; rendement brut immeubles récents let. c ; réévaluation des fonds propres au renchérissement let. e).

### 3.2 Les conditions d'éligibilité (art. 270 al. 1), alternatives
Il faut se trouver dans l'une des hypothèses :
1. **Pénurie / situation du marché** (let. a) — **VD et GE sont en pénurie reconnue** : le Tribunal fédéral a confirmé qu'à Genève la seule pénurie suffit à ouvrir le droit de contester, sans devoir prouver une contrainte personnelle ni une hausse. Vaud est dans une logique analogue. → **Dans ces deux cantons, l'éligibilité de principe est quasi automatique.** C'est le socle qui rend le produit viable là et pas partout.
2. **Contrainte personnelle/familiale** (let. a alt.) — nécessité, divorce, naissance, etc. (bonus argumentaire, renseigné en flux manuel).
3. **Hausse sensible vs ancien locataire** (let. b) — une hausse **> 10 %** sans travaux à plus-value est généralement « sensible » et constitue un **indice fort d'abus**.

### 3.3 Le motif « tueur » : formule officielle manquante
La **formule officielle de notification du loyer initial** (obligatoire à VD et GE) doit être remise au locataire à la conclusion du bail. Si elle est **absente, incomplète, obsolète ou tardive** :
- le loyer initial est **contestable EN TOUT TEMPS** (le délai de 30 jours ne court pas) ;
- il peut être frappé de **nullité** ;
- restitution du trop-perçu possible **jusqu'à 10 ans** en arrière.

→ C'est le motif **le plus fort ET le plus facile à établir côté locataire** (une simple case « as-tu reçu la formule ? »). Il court-circuite toute analyse de rendement. À placer en tête de la hiérarchie des motifs.

### 3.4 Le rendement excessif : ce que l'outil PEUT et NE PEUT PAS faire
Le critère ultime d'abus est le **rendement net excessif**. Son calcul (jurisprudence ATF 147 III 14 / confirmé 4A_111/2023, 4A_339/2022) suit ces étapes : coûts d'investissement effectifs → déduction des fonds étrangers → fonds propres investis → **réévaluation à 100 % au renchérissement (ISPC)** → application du **taux admissible = taux de référence + 2 pts** (tant que le taux de référence est ≤ 2 %) → ajout des charges immobilières → comparaison au loyer effectif.

**État actuel des paramètres :**
- Taux hypothécaire de référence : **1,25 %** (inchangé depuis le 02.09.2025, confirmé au 02.06.2026 ; prochaine publication OFL 01.09.2026). → **À sourcer en direct depuis bwo.admin.ch, jamais coder en dur.**
- Rendement net admissible actuel : **1,25 % + 2 % = 3,25 %** sur fonds propres réévalués, + charges.
- Immeuble récent (≤ 10 ans) : rendement brut (269a let. c) = taux réf + 3,5 % (1,5 % charges + 2 % rendement).
- Immeuble ancien (≥ 30 ans, même propriétaire) : la hiérarchie s'inverse, ce sont les **loyers usuels du quartier** (269a let. a) qui priment.

**⚠️ Point structurant :** le locataire n'a JAMAIS le prix de revient, le montant hypothécaire, les fonds propres, les charges. **L'outil ne calcule donc pas le rendement.** La lettre :
1. invoque le **doute** sur le caractère non-excessif du rendement ;
2. **somme le bailleur de produire** son décompte de rendement net ;
3. rappelle qu'à défaut de collaboration, l'autorité **tranche en équité** (défavorable au bailleur) ;
4. conclut à la diminution du loyer + restitution du trop-perçu + adaptation de la garantie.

Le chiffre « 3,25 % » ne sert que de **pédagogie** dans l'interface, pas de preuve.

### 3.5 Produit gratuit : demande de baisse (taux de référence)
Indépendant de la contestation initiale. Si le loyer actuel repose sur un taux de référence **supérieur** à 1,25 %, le locataire a droit à une baisse pour le **prochain terme de résiliation**. Ordre de grandeur : chaque **−0,25 pt ≈ −2,91 %** du loyer net (à combiner avec IPC/coûts, approximatif). Procédure : demande écrite au bailleur → s'il refuse/ne répond pas sous 30 j → saisir l'autorité dans les 30 j. → Excellent aimant à leads.

### 3.6 Destinataire de la requête
- **Genève** : une seule autorité cantonale (voir §8).
- **Vaud** : la **préfecture du district du lieu de situation de l'immeuble** (10 districts). Le dépôt de la requête **suspend** les effets de la hausse/résiliation jusqu'à décision.
- **Jamais** la régie.
- Forme : à Genève, une **simple lettre datée et signée** contenant la désignation des parties, les conclusions et les motifs suffit (des requêtes-type officielles existent et servent de modèle). Idem esprit à VD.

---

## 4. RULESET (pièce centrale)

### 4.1 Modèle de données (JSON)
```json
{
  "canton": "VD | GE",
  "npa": "string",
  "commune": "string",
  "adresse_immeuble": "string",
  "date_remise_cles": "YYYY-MM-DD",
  "loyer_net_mensuel": 0,
  "charges_mensuelles": 0,
  "formule_officielle_recue": "true | false | inconnu",
  "loyer_precedent_connu": false,
  "loyer_precedent_net": null,
  "taux_reference_bail": null,
  "annee_construction": null,
  "contrainte_personnelle": false,
  "locataire": { "nom": "", "prenom": "", "adresse": "", "npa": "", "ville": "", "email": "" },
  "bailleur": { "nom": "", "adresse": "", "npa": "", "ville": "" },
  "signature_data_url": null
}
```

### 4.2 Arbre de décision — contestation loyer initial
```
ENTRÉE: objet de données ci-dessus
jours_ecoules = aujourd'hui − date_remise_cles

# STEP 0 — Compétence
autorite = resolveAutorite(canton, npa/commune)   # via dataset §8
SI autorite introuvable -> flag manuel (notif exploitant)

# STEP 1 — Vice de forme (motif prioritaire)
SI formule_officielle_recue == false:
    MOTIF["formule_manquante"] = FORCE_TRES_FORTE
    -> nullité du loyer initial, contestable EN TOUT TEMPS
    -> conclusions: fixation judiciaire + restitution trop-perçu (≤10 ans)
    -> IGNORER le gate délai (STEP 2)
SI formule_officielle_recue == inconnu:
    -> poser la question avant de conclure; sinon motif conditionnel

# STEP 2 — Délai (seulement si formule reçue)
SI formule reçue ET jours_ecoules > 30:
    -> HORS DÉLAI loyer initial (transparence: ne pas vendre une lettre vaine)
    -> proposer à la place le produit "demande de baisse" (§4.3) si éligible
    -> STOP contestation loyer initial
SINON:
    -> éligible sur le délai

# STEP 3 — Condition matérielle art. 270 (au moins une)
conditions = []
SI canton in {VD, GE}: conditions.push("penurie_reconnue")   # quasi automatique
SI loyer_precedent_connu ET loyer_precedent_net:
    hausse_pct = (loyer_net_mensuel − loyer_precedent_net) / loyer_precedent_net
    SI hausse_pct > 0.10: 
        conditions.push("hausse_sensible")
        MOTIF["hausse_sensible"] = FORCE_FORTE (valeur: round(hausse_pct*100)%)
SI contrainte_personnelle: conditions.push("contrainte_personnelle")
SI conditions vide: -> improbable en VD/GE, mais flag manuel

# STEP 4 — Présomption d'abus / rendement (cœur scare-to-settle)
MOTIF["presomption_rendement"] = FORCE_MOYENNE
    -> texte: doute sur rendement non-excessif (art. 269)
    -> sommation de produire le décompte de rendement net
    -> rappel équité si non-collaboration
taux_ref = fetchTauxReference()      # live, bwo.admin.ch (fallback 1.25)
rendement_admissible_pct = taux_ref + 2     # pédagogie UI seulement

# STEP 5 — Axe argumentaire selon l'âge
SI annee_construction ET (annee_courante − annee_construction) >= 30:
    axe = "loyers_usuels_quartier"   # 269a let. a prime
SINON:
    axe = "rendement_net"            # (ou brut si <10 ans)

# STEP 6 — Sortie
motifs_classes = sort(MOTIF, par force desc)
# Hiérarchie: formule_manquante > hausse_sensible > presomption_rendement > loyers_usuels
retourner { autorite, motifs_classes, axe, conclusions, donnees_lettre }
```

### 4.3 Arbre de décision — demande de baisse (gratuit, lead magnet)
```
SI taux_reference_bail != null ET taux_reference_bail > fetchTauxReference():
    delta_pts = taux_reference_bail − taux_ref
    baisse_estimee_pct ≈ delta_pts / 0.25 * 2.91    # approximation, à afficher "indicatif"
    -> éligible: droit à une baisse pour le prochain terme
    -> capter email -> proposer génération lettre de demande de baisse
SINON:
    -> pas de droit à la baisse via ce seul critère (mais autres facteurs possibles)
```

### 4.4 Conclusions-type de la requête (à intégrer aux templates)
Les conclusions sont présentées dans leur ordre procédural, sans laisser entendre que
l'abus est établi avant l'accès aux données détenues par le bailleur :

1. **Préalablement** : requérir la production des pièces permettant de déterminer la
   méthode applicable et de contrôler le loyer (rendement net ou brut ; subsidiairement,
   objets comparables si les loyers usuels sont invoqués).
2. **Au fond, après examen des pièces** :
   - (si formule manquante) constater la nullité de la fixation du loyer initial ;
   - fixer le loyer initial net à un montant non abusif, sous réserve de préciser la
     conclusion une fois les données disponibles ;
   - restituer la différence payée en trop depuis l'entrée en jouissance ;
   - adapter la garantie de loyer au montant finalement fixé.

La conclusion autonome « constater le caractère abusif » est supprimée : elle était
redondante avec la fixation judiciaire et donnait à tort l'impression que l'abus était
déjà prouvé.

> **Modèles à suivre** : les requêtes-type officielles de la Commission de conciliation GE (baisse de loyer / contestation) et l'esprit des requêtes préfectorales VD. Ne pas recopier verbatim ; s'en inspirer pour la structure et les conclusions.

---

## 5. Workflow produit (bout en bout)

```
Landing → choix parcours (import bail | manuel)
   │
   ├── IMPORT: upload bail (+ formule officielle obligatoire)
   │        → extraction Claude API → JSON → préremplissage → validation user
   │
   └── MANUEL: 6-8 questions conditionnelles → JSON
   │
   ▼
RULESET (§4) → motifs classés + éligibilité + autorité
   │
   ▼
Génération lettre (HTML → PDF serveur)
   │
   ▼
PREVIEW FILIGRANÉ (images matricielles, filigranes incrustés — PDF propre JAMAIS exposé)
   │
   ▼
Choix offre → PAIEMENT Stripe (14,90 ou 49,90 CHF, TWINT/carte)
   │
   ├── 14,90 CHF → création compte → PDF propre + checklist débloqués (téléchargement) → suivi
   └── 49,90 CHF → capture SIGNATURE → PDF signé → Pingen (recommandé, expéditeur=locataire)
                 → webhook suivi → compte + tracking dans le dashboard
   │
   ▼
Purge de toutes les données à J+7
   │
   (Échec génération/adresse) → notif exploitant → traitement manuel
```

**Règles clés :**
- **Formule obligatoire à l'import** (sinon la condition « hausse vs ancien locataire » est inqualifiable).
- **Le PDF propre n'existe côté client qu'après paiement** ; le preview = PNG aplatis avec filigranes incrustés dans l'image (pas d'overlay CSS retirable).
- **Compte créé après paiement** seulement, pour le suivi.
- **Gate délai transparent** : si hors délai (et formule reçue), le dire et rediriger vers la demande de baisse plutôt que vendre une lettre vaine.

---

## 6. Génération de la lettre & preview filigrané

- **Template** : HTML/CSS format lettre suisse (en-tête locataire, destinataire = autorité de conciliation, lieu/date, objet, exposé des motifs classés, conclusions, signature).
- **HTML → PDF** : service dédié. Reco : **Gotenberg** (open-source, gratuit, self-host sur l'hébergeur suisse) ou une API HTML→PDF pay-per-use pour démarrer (volume faible). Éviter Playwright dans une edge function Deno.
- **Preview anti-fuite** :
  1. Générer le vrai PDF côté serveur.
  2. Le rasteriser page par page en PNG basse résolution.
  3. Incruster des filigranes diagonaux répétés **dans l'image** (« APERÇU — contestation.ch — payez pour débloquer »).
  4. Servir uniquement ces PNG. Le PDF propre reste sur le serveur jusqu'au paiement validé (endpoint protégé).

---

## 7. Stack technique (arrêtée)

**Approche de build :** logique/ruleset/intégrations (Stripe, Pingen, edge functions) via **Claude Code** ; landing + funnel + UX du preview via **Claude Design** ; assemblage et itération visuelle via **Lovable**.

| Couche | Choix | Raison |
|---|---|---|
| Frontend | React + Vite + Tailwind | Natif Lovable, rapide |
| Backend / DB / Auth / Storage | Supabase (Postgres, Auth, Storage, Edge Functions Deno) | Natif Lovable, tiers gratuit, rapide |
| Extraction bail | **Claude API** (support PDF natif : envoi du PDF en base64 → sortie JSON structurée via tool use ; gère texte ET scans, souvent sans OCR séparé) | Fiable, structuré, zero-retention |
| Moteur de règles | Module TypeScript pur, **testé unitairement** | C'est du droit : reproductible et auditable |
| HTML→PDF | Gotenberg self-host (ou API pay-per-use au départ) | Coût nul / setup nul |
| Preview | Rastérisation PNG + filigranes incrustés | Anti-fuite |
| Paiement | **Stripe Checkout** (CHF, carte + **TWINT**) | Vitesse + TWINT natif |
| Recommandé | **Pingen** API (sandbox → prod), webhooks statut | Seul acteur API clé-en-main CH, gratuit |
| Taux de référence | Fetch live bwo.admin.ch (cache court, fallback 1,25) | Ne jamais coder en dur |
| Notifs exploitant | Email/Slack sur échec génération | Traitement manuel |

**Hébergement / résidence des données (à arbitrer — voir §11) :** tu as demandé « hébergement en Suisse », mais le chemin le plus rapide (Lovable + Supabase) place la DB en UE (Francfort). Reco pragmatique MVP : **stocker les documents sensibles (baux, formules, lettres générées) dans un bucket objet suisse (Infomaniak Object Storage ou Exoscale SOS)** avec purge auto à J+7, et garder l'app Supabase en UE. La privacy policy indique alors honnêtement : app en UE, documents en Suisse. Pour une revendication « 100 % hébergé en Suisse », migrer toute l'app sur Infomaniak dans un second temps.

---

## 8. Dataset autorités de conciliation (VD + GE)

### 8.1 Genève — une seule autorité cantonale
```
Commission de conciliation en matière de baux et loyers
Rue de l'Athénée 6-8
Case postale 3120
1211 Genève 3
Tél. 022 327 62 10
```
→ Toute requête GE (tout NPA du canton) va à cette adresse. Simple : pas de mapping NPA nécessaire pour GE.

### 8.2 Vaud — par district (préfecture du lieu de l'immeuble)
La requête va à la **préfecture du district** où se situe l'immeuble. 10 districts :

| District | Chef-lieu (localité de dépôt) |
|---|---|
| Aigle | Aigle |
| Broye-Vully | Payerne (~1530) |
| Gros-de-Vaud | Echallens (~1040) |
| Jura-Nord vaudois | Yverdon-les-Bains (~1400) |
| Lausanne | Lausanne (~1014) |
| Lavaux-Oron | Cully (~1096) |
| Morges | Morges (~1110) |
| Nyon | Nyon (~1260) |
| Ouest lausannois | Renens (~1020) |
| Riviera-Pays-d'Enhaut | Vevey / Montreux |

**À finaliser avant lancement VD (tâche de build) :**
1. Récupérer les **adresses postales complètes** des 10 préfectures depuis les pages officielles `vd.ch/etat-droit-finances/districts-/-prefectures/prefectures/<district>`.
2. Construire la table **NPA/commune → district** depuis la liste officielle des communes par district (`vd.ch/etat-droit-finances/communes/liste-des-communes-et-districts`). Attention : certaines communes de même nom, se fier au NPA + commune.
3. Fonction `resolveAutorite(canton, npa, commune)` → renvoie le bloc adresse.

> **Astuce périmètre** : lancer d'abord **Genève** (une seule adresse, zéro mapping) puis Vaud (mapping district). Réduit le risque « mauvaise adresse » au démarrage.

---

## 9. Économie unitaire

| Offre | Prix | Coûts variables | Marge nette approx. |
|---|---|---|---|
| Lettre à imprimer | 14,90 CHF | Frais Stripe + génération | Marge à recalculer |
| Recommandé | 49,90 CHF | Pingen recommandé + frais Stripe + génération | Marge à recalculer |

À 10/mois (mix), le CA est modeste (ordre de 100–350 CHF/mois) : les marges sont saines, **le levier c'est le volume** (SEO programmatique + ads). Un 3ᵉ palier possible plus tard : recommandé + relance automatique à J+30 si pas de réponse.

---

## 10. Plan de build séquencé (réaliste)

Le « lancement aujourd'hui » se traduit ainsi : **la landing + le calculateur gratuit peuvent partir aujourd'hui** ; le flux payant demande quelques jours.

- **Phase 0 — Aujourd'hui.** Landing contestation.ch + **calculateur « ai-je droit à une baisse ? »** (taux de référence) + capture email/waitlist. Claude Design + Lovable. → génère des leads immédiatement, valide la demande.
- **Phase 1 — J+2 à J+5 — MVP payant Genève.** Flux **manuel** loyer initial GE → ruleset → lettre → preview filigrané → **Stripe 14,90 CHF** (impression soi-même). GE d'abord (une seule adresse).
- **Phase 2 — J+5 à J+10.** Ajout **Vaud** (dataset préfectures) + **flux import bail** (Claude API) + **offre 49,90 CHF** (Pingen sandbox→prod + capture signature).
- **Phase 3 — J+10+.** SEO programmatique (pages par motif : « formule manquante », « hausse >10 % », « baisse taux de référence », par canton), Facebook Ads, itération sur le taux de conversion du preview.

---

## 11. Conformité, légal & risques

### 11.1 Positionnement (assumé)
- contestation.ch est un **outil d'aide à la génération de courrier**, **pas** un conseil juridique ni un cabinet.
- **Aucune responsabilité** : à afficher clairement dans le flux, sur le site et dans les CGV. Il appartient au locataire de vérifier lui-même que sa procédure avance (délais, réception, suites).
- **Renvoi ASLOCA** pour les cas complexes (décomptes de rendement, plus-values, immeubles anciens, litiges).
- Disclaimer visible **avant paiement** (pas seulement dans les CGV).

### 11.2 Protection des données (nLPD)
- Données personnelles + documents sensibles (baux, formules) → **DPA** avec Stripe, Pingen, fournisseur LLM ; **Claude API en zero-retention**.
- **Rétention 7 jours** : purge automatique (job planifié) de la DB **et** du bucket de stockage. Documenter dans la privacy policy.
- Privacy policy honnête sur la localisation (voir §7 : app UE / documents CH selon l'arbitrage).
- Bannières cookies : option la plus protectrice par défaut.

### 11.3 Risques identifiés (choix assumés à surveiller)
- **Pas de relecture juridique / pas de RC pro / pas de partenariat ASLOCA.** Le risque (délai raté, mauvaise autorité, motif inadéquat) repose **entièrement sur la qualité du ruleset et sur les disclaimers**. Mitigation minimale : (a) tests unitaires exhaustifs du ruleset ; (b) gate délai strict et transparent ; (c) dataset adresses vérifié ; (d) disclaimers pré-paiement. Une relecture ponctuelle du ruleset par un juriste bail reste fortement recommandée même hors partenariat — c'est le poste où une erreur coûte le plus cher.
- **Signature** : une signature dessinée apposée sur la lettre imprimée/postée est acceptée en conciliation (GE admet une simple lettre signée). Ce n'est pas une signature électronique qualifiée, et ce n'est pas requis à ce stade.
- **Budget 50 CHF** : couvre le domaine + les tiers gratuits (Supabase free, Stripe sans abonnement, Pingen sans abonnement, Gotenberg gratuit). Ne couvre **pas** une relecture juridique ni le budget ads (à prévoir séparément).
- **Veille législative** : surveiller toute réforme de l'art. 269 ss (motion 20.3922) et les publications trimestrielles OFL du taux de référence.

---

## 12. Décisions ouvertes à trancher

1. **Hébergement** : hybride (app Supabase UE + documents bucket CH) pour la vitesse, OU tout Infomaniak pour la revendication « 100 % Suisse » ? (Reco : hybride pour le MVP.)
2. **HTML→PDF** : Gotenberg self-host (gratuit, un peu de setup) OU API pay-per-use (zéro setup, micro-coût) ?
3. **Ordre de lancement cantons** : GE seul d'abord (reco) puis VD ?
4. **Relecture ruleset** par un juriste : vraiment zéro, ou une passe ponctuelle payante hors partenariat ?
5. **Taux de référence** : fetch live avec cache — définir la fréquence de rafraîchissement (trimestriel suffit, mais prévoir un fallback).

---

*Prochaine pièce à produire : le ruleset TypeScript complet (fonctions `resolveAutorite`, `evaluateLoyerInitial`, `evaluateDemandeBaisse`) + le schéma de prompt Claude API pour l'extraction du bail, prêts à coller dans Claude Code.*
