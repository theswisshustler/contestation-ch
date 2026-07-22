import {
  buildClaudeExtractionRequest,
  ClaudeExtractionError,
  EXTRACTION_JSON_SCHEMA,
  parseClaudeExtraction,
} from './bail-extraction.js';

function rawExtraction(overrides = {}) {
  return {
    canton: 'VD',
    npa: '1004',
    commune: 'Lausanne',
    adresseImmeuble: 'Avenue de Sévery 7',
    dateRemiseCles: '2023-02-01',
    loyerNetMensuel: 1800,
    chargesMensuelles: 190,
    formuleOfficielleRecue: 'oui',
    loyerPrecedentConnu: true,
    loyerPrecedentNet: 1600,
    tauxReferenceBail: 1.25,
    anneeConstruction: 1998,
    locataire: { nom: 'Dupont', prenom: 'Anne', adresse: '', npa: '', ville: '' },
    bailleur: { nom: 'Régie SA', prenom: '', adresse: 'Rue Centrale 1', npa: '1003', ville: 'Lausanne' },
    champs_incertains: [],
    ...overrides,
  };
}

describe('contrat d’extraction Claude', () => {
  it('demande une sortie JSON structurée et assez de tokens', () => {
    const request = buildClaudeExtractionRequest({
      model: 'claude-sonnet-4-6',
      bailB64: 'JVBER-bail',
      formuleB64: 'JVBER-formule',
    });

    expect(request.max_tokens).toBe(4096);
    expect(request.output_config.format.type).toBe('json_schema');
    expect(request.output_config.format.schema).toBe(EXTRACTION_JSON_SCHEMA);
    expect(request.output_config.format.schema.properties.canton.anyOf).toEqual([
      { type: 'string', enum: ['VD', 'GE'] },
      { type: 'null' },
    ]);
    expect(request.output_config.format.schema.properties.champs_incertains).not.toHaveProperty('maxItems');
    expect(request.messages[0].content.filter((block) => block.type === 'document')).toHaveLength(2);
  });

  it('normalise une réponse structurée avant de la transmettre au parcours', () => {
    const extracted = parseClaudeExtraction({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(rawExtraction()) }],
    }, true);

    expect(extracted).toMatchObject({
      canton: 'VD',
      npa: '1004',
      loyerNetMensuel: 1800,
      formuleOfficielleRecue: 'oui',
      loyerPrecedentConnu: true,
      loyerPrecedentNet: 1600,
    });
    expect(extracted.locataire.adresse).toBeNull();
  });

  it('ne déduit jamais la formule ni le loyer précédent quand elle n’est pas jointe', () => {
    const extracted = parseClaudeExtraction({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(rawExtraction()) }],
    }, false);

    expect(extracted.formuleOfficielleRecue).toBe('inconnu');
    expect(extracted.loyerPrecedentConnu).toBe(false);
    expect(extracted.loyerPrecedentNet).toBeNull();
  });

  it('reste compatible avec une ancienne réponse entourée de texte', () => {
    const extracted = parseClaudeExtraction({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: `Résultat :\n${JSON.stringify(rawExtraction())}\nFin.` }],
    }, true);

    expect(extracted.commune).toBe('Lausanne');
  });

  it('identifie explicitement une réponse tronquée', () => {
    expect(() => parseClaudeExtraction({
      stop_reason: 'max_tokens',
      content: [{ type: 'text', text: '{"canton":"VD"' }],
    }, false)).toThrowError(expect.objectContaining({
      name: 'ClaudeExtractionError',
      code: 'truncated',
    }));
  });

  it('rejette un contenu non JSON sans exposer son texte', () => {
    try {
      parseClaudeExtraction({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Impossible de lire le document.' }],
      }, false);
      throw new Error('Le parseur aurait dû échouer.');
    } catch (error) {
      expect(error).toBeInstanceOf(ClaudeExtractionError);
      expect(error.code).toBe('invalid_json');
      expect(error.message).not.toContain('Impossible de lire');
    }
  });
});
