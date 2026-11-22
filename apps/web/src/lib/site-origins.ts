export type HostRole = 'site' | 'app' | 'combined';

function asOrigin(value: string | undefined) {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

export function createSiteOrigins(siteOriginValue?: string, appOriginValue?: string) {
  const siteOrigin = asOrigin(siteOriginValue);
  const appOrigin = asOrigin(appOriginValue);
  const splitActive =
    siteOrigin !== undefined && appOrigin !== undefined && siteOrigin !== appOrigin;

  return {
    splitActive,
    hostRole(origin = typeof window === 'undefined' ? '' : window.location.origin): HostRole {
      if (!splitActive) return 'combined';
      if (origin === siteOrigin) return 'site';
      if (origin === appOrigin) return 'app';
      return 'combined';
    },
    appUrl(pathAndSearch: string) {
      return splitActive && appOrigin ? new URL(pathAndSearch, appOrigin).href : pathAndSearch;
    },
    siteUrl(path: string) {
      return splitActive && siteOrigin ? new URL(path, siteOrigin).href : path;
    },
  };
}

const siteOrigins = createSiteOrigins(
  import.meta.env.VITE_SITE_ORIGIN,
  import.meta.env.VITE_APP_ORIGIN,
);

export const hostRole = siteOrigins.hostRole;
export const appUrl = siteOrigins.appUrl;
export const siteUrl = siteOrigins.siteUrl;
