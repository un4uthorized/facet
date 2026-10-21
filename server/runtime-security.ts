interface SecurityEnvironment {
  NODE_ENV?: string;
  COOKIE_SECURE?: string;
  TRUST_PROXY?: string;
}

/** Validate deployment security before initializing the database or HTTP server. */
export function runtimeSecurity(environment: SecurityEnvironment): { production: boolean; secureCookies: boolean; trustProxy: 1 | false } {
  const production = environment.NODE_ENV === 'production';
  const secureSetting = environment.COOKIE_SECURE;
  if (secureSetting !== undefined && !['true', 'false'].includes(secureSetting)) {
    throw new Error('COOKIE_SECURE deve ser true ou false.');
  }
  if (production && secureSetting === 'false') {
    throw new Error('COOKIE_SECURE=false não é permitido em produção. Configure HTTPS e cookies seguros.');
  }
  const trustProxySetting = environment.TRUST_PROXY;
  if (trustProxySetting !== undefined && !['true', '1', 'false'].includes(trustProxySetting)) {
    throw new Error('TRUST_PROXY deve ser true ou false.');
  }
  return {
    production,
    secureCookies: production || secureSetting === 'true',
    trustProxy: ['true', '1'].includes(trustProxySetting ?? '') ? 1 : false,
  };
}
