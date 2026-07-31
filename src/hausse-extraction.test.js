import {
  buildHausseExtractionRequest,
  HAUSSE_EXTRACTION_JSON_SCHEMA,
  normalizeHausseExtraction,
  parseHausseExtractionResponse,
} from './hausse-extraction.js';

const raw = (overrides = {}) => ({
  canton: 'VD',
  npa: '1004',
  commune: 'Lausanne',
  adresseImmeuble: 'Avenue de Sévery 7',
  dateNotificationHausse: '2026-07-20',
  dateEffetHausse: '2026-10-01',
  loyerAvantHausse: 1800,
  loyerApresHausse: 1890,
  chargesMensuelles: 190,
  formuleHausseRecue: 'oui',
  motifHausse: 'oui',
  tauxReferenceBail: 1.5,
  tauxReferenceNouveau: 1.75,
  motifsInvoques: ['Adaptation au taux de référence de 1,75 %', 'Renchérissement de 40 % de l’IPC'],
  locataire: { nom: 'Dupont', prenom: 'Anne', adresse: '', npa: '', ville: '' },
  bailleur: { nom: 'Régie SA', prenom: '', adresse: 'Rue Centrale 1', npa: '1003', ville: 'Lausanne' },
  champs_incertains: [],
  ...overrides,
});

describe('extraction d’une notification de hausse', () => {
  it('envoie la notification comme document principal et le bail comme complément', () => {
    const request = buildHausseExtractionRequest({
      model: 'claude-sonnet-4-6',
      notificationB64: 'JVBER-notification',
      bailB64: 'JVBER-bail',
    });
    expect(request.output_config.format.schema).toBe(HAUSSE_EXTRACTION_JSON_SCHEMA);
    expect(request.messages[0].content.filter((block) => block.type === 'document')).toHaveLength(2);
    expect(request.system).toContain('tous les motifs invoqués');
  });

  it('normalise séparément les anciens et nouveaux montants et taux', () => {
    const result = parseHausseExtractionResponse({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(raw()) }],
    });
    expect(result).toMatchObject({
      dateNotificationHausse: '2026-07-20',
      loyerAvantHausse: 1800,
      loyerApresHausse: 1890,
      tauxReferenceBail: 1.5,
      tauxReferenceNouveau: 1.75,
      formuleHausseRecue: 'oui',
    });
    expect(result.motifsInvoques).toHaveLength(2);
  });

  it('rejette les valeurs aberrantes sans les transmettre au diagnostic', () => {
    const result = normalizeHausseExtraction(raw({
      npa: 'ABC',
      dateEffetHausse: 'demain',
      loyerApresHausse: 500000,
      tauxReferenceNouveau: 99,
    }));
    expect(result.npa).toBeNull();
    expect(result.dateEffetHausse).toBeNull();
    expect(result.loyerApresHausse).toBeNull();
    expect(result.tauxReferenceNouveau).toBeNull();
  });
});
