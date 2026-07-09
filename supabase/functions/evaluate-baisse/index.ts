// POST /evaluate-baisse  (produit d'appel gratuit — lead magnet)
// Entrée : { tauxReferenceBail: number|null, loyerNetMensuel: number,
//            email?: string, canton?: string }
// Sortie : { result } de evaluateDemandeBaisse. Capture l'email en lead.

import { evaluateDemandeBaisse } from '../_shared/ruleset.ts';
import { adminClient } from '../_shared/supabase.ts';
import { badRequest, json, preflight, serverError } from '../_shared/http.ts';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return badRequest('POST attendu');

  let body: {
    tauxReferenceBail?: number | null;
    loyerNetMensuel?: number;
    email?: string;
    canton?: string;
  };
  try {
    body = await req.json();
  } catch {
    return badRequest('JSON invalide');
  }

  if (typeof body.loyerNetMensuel !== 'number') {
    return badRequest('loyerNetMensuel requis');
  }

  const result = evaluateDemandeBaisse(body.tauxReferenceBail ?? null, body.loyerNetMensuel);

  try {
    if (body.email) {
      const db = adminClient();
      await db.from('leads').insert({
        email: body.email,
        canton: body.canton ?? null,
        result,
        source: 'calculateur_baisse',
      });
    }
  } catch (e) {
    // La capture de lead ne doit jamais casser la réponse au visiteur.
    console.error('lead insert failed', e);
  }

  return json({ result });
});
