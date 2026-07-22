-- Une génération peut aboutir côté serveur alors que le navigateur perd la
-- réponse. Le retry doit réutiliser la lettre existante, jamais en créer une
-- seconde. L'état de production a été contrôlé avant cette migration : aucun
-- dossier ne possède plusieurs lettres.
create unique index if not exists letters_one_per_dossier_idx
  on public.letters (dossier_id);
