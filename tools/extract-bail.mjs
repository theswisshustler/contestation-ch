import {
  buildClaudeExtractionRequest,
  ClaudeExtractionError,
  parseClaudeExtraction,
} from '../src/bail-extraction.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

export async function extractBailDocuments({ bailB64, formuleB64 }, env = process.env) {
  if (!bailB64) return [400, { error: 'bailB64 requis' }];
  if (!env.ANTHROPIC_API_KEY) {
    return [503, {
      error: "Extraction réelle non configurée : ajoutez ANTHROPIC_API_KEY dans supabase/functions/.env. Aucune donnée fictive n'a été générée.",
    }];
  }

  try {
    const response = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(buildClaudeExtractionRequest({
        model: env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
        bailB64,
        formuleB64,
      })),
    });

    if (!response.ok) {
      return [502, {
        error: response.status === 429
          ? 'Le service d’analyse est momentanément saturé. Réessayez dans une minute.'
          : `Échec du service d’extraction (${response.status}).`,
      }];
    }

    const data = await response.json();
    const extracted = parseClaudeExtraction(data, Boolean(formuleB64));
    return [200, {
      extracted,
      extraction: { provider: 'anthropic', model: data.model || env.ANTHROPIC_MODEL },
    }];
  } catch (error) {
    const code = error instanceof ClaudeExtractionError ? error.code : 'network_error';
    return [502, {
      error: code === 'truncated'
        ? 'Le document est trop complexe pour une seule analyse. Réessayez avec un PDF compressé.'
        : 'Le service d’analyse n’a pas pu interpréter ce document. Réessayez.',
      code,
    }];
  }
}
