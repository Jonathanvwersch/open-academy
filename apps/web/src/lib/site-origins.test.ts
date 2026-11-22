import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSiteOrigins } from './site-origins.js';

afterEach(() => vi.unstubAllGlobals());

describe('createSiteOrigins', () => {
  it('recognizes the configured site and app origins and builds absolute URLs', () => {
    const origins = createSiteOrigins('https://openacademy.dev/', 'https://app.openacademy.dev');

    expect(origins.splitActive).toBe(true);
    expect(origins.hostRole('https://openacademy.dev')).toBe('site');
    expect(origins.hostRole('https://app.openacademy.dev')).toBe('app');
    expect(origins.hostRole('https://preview.vercel.app')).toBe('combined');
    expect(origins.appUrl('/login?redirect=%2Flessons%2Fvectors')).toBe(
      'https://app.openacademy.dev/login?redirect=%2Flessons%2Fvectors',
    );
    expect(origins.siteUrl('/how-it-works')).toBe('https://openacademy.dev/how-it-works');
  });

  it('uses the current browser origin by default', () => {
    vi.stubGlobal('window', { location: { origin: 'https://app.openacademy.dev' } });
    const origins = createSiteOrigins('https://openacademy.dev', 'https://app.openacademy.dev');

    expect(origins.hostRole()).toBe('app');
  });

  it.each([
    [undefined, 'https://app.openacademy.dev'],
    ['https://openacademy.dev', undefined],
    ['https://openacademy.dev', 'https://openacademy.dev/'],
  ])('keeps combined mode when the split origins are missing or equal', (site, app) => {
    const origins = createSiteOrigins(site, app);

    expect(origins.splitActive).toBe(false);
    expect(origins.hostRole('https://openacademy.dev')).toBe('combined');
    expect(origins.hostRole('https://app.openacademy.dev')).toBe('combined');
    expect(origins.appUrl('/login?next=/')).toBe('/login?next=/');
    expect(origins.siteUrl('/courses')).toBe('/courses');
  });
});
