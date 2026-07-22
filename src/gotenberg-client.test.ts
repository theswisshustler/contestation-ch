import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureGotenbergReady,
  htmlToPdf,
  htmlToPng,
} from '../supabase/functions/_shared/gotenberg.ts';

describe('client Gotenberg', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('Deno', {
      env: {
        get: (name: string) => name === 'GOTENBERG_URL' ? 'https://gotenberg.test/' : undefined,
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('attend que Chromium soit prêt avant de lancer les conversions', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{"status":"down"}', { status: 503 }))
      .mockResolvedValueOnce(new Response('{"status":"up"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const readiness = ensureGotenbergReady();
    await vi.runAllTimersAsync();

    await expect(readiness).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('https://gotenberg.test/health');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'GET' });
  });

  it('rejoue une conversion après un 500 transitoire de démarrage', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('Internal Server Error', {
        status: 500,
        headers: { 'Gotenberg-Trace': 'trace-cold-start' },
      }))
      .mockResolvedValueOnce(new Response(new Uint8Array([37, 80, 68, 70]), {
        status: 200,
        headers: { 'Content-Type': 'application/pdf' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const conversion = htmlToPdf('<!doctype html><h1>Lettre</h1>');
    await vi.runAllTimersAsync();

    await expect(conversion).resolves.toEqual(new Uint8Array([37, 80, 68, 70]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('https://gotenberg.test/forms/chromium/convert/html');
    expect(fetchMock.mock.calls[0][1].body).not.toBe(fetchMock.mock.calls[1][1].body);
  });

  it('rejoue aussi une erreur réseau temporaire', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('network unavailable'))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const conversion = htmlToPdf('<!doctype html><p>Test</p>');
    await vi.runAllTimersAsync();

    await expect(conversion).resolves.toEqual(new Uint8Array([1, 2, 3]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('ne rejoue pas une erreur de formulaire 400', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('field files is required', {
      status: 400,
      headers: { 'Gotenberg-Trace': 'trace-invalid-form' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(htmlToPdf('<html></html>')).rejects.toThrow(
      'Gotenberg PDF 400: field files is required (trace trace-invalid-form)',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('conserve la route et les paramètres PNG du preview filigrané', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      const form = init.body as FormData;
      expect(url).toBe('https://gotenberg.test/forms/chromium/screenshot/html');
      expect(form.get('format')).toBe('png');
      expect(form.get('width')).toBe('820');
      expect(form.get('optimizeForSpeed')).toBe('true');
      return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(htmlToPng('<html></html>')).resolves.toEqual(new Uint8Array([137, 80, 78, 71]));
  });
});
