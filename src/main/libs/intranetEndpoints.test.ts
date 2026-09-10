import { describe, expect, test } from 'vitest';

import { resolveIntranetBaseUrl } from './intranetEndpoints';

const compiledDefault = 'http://127.0.0.1:8080';

describe('intranetEndpoints', () => {
  test('returns null when neither the variable nor the compiled default is set', () => {
    expect(resolveIntranetBaseUrl(undefined, '')).toBeNull();
    expect(resolveIntranetBaseUrl('', '')).toBeNull();
    expect(resolveIntranetBaseUrl('   ', '  ')).toBeNull();
  });

  test('prefers the environment variable over the compiled default', () => {
    expect(resolveIntranetBaseUrl('http://10.0.0.5:8080', compiledDefault))
      .toBe('http://10.0.0.5:8080');
  });

  test('falls back to the compiled default', () => {
    expect(resolveIntranetBaseUrl(undefined, ` ${compiledDefault} `)).toBe(compiledDefault);
    expect(resolveIntranetBaseUrl('  ', 'http://10.0.0.5:8080')).toBe('http://10.0.0.5:8080');
  });

  test('normalizes the value to a bare origin', () => {
    expect(resolveIntranetBaseUrl(undefined, `${compiledDefault}/`)).toBe(compiledDefault);
    expect(resolveIntranetBaseUrl(undefined, 'http://user:secret@10.0.0.5:8080'))
      .toBe('http://10.0.0.5:8080');
    expect(resolveIntranetBaseUrl(undefined, 'http://10.0.0.5:8080?mode=test'))
      .toBe('http://10.0.0.5:8080');
    expect(resolveIntranetBaseUrl(undefined, 'http://10.0.0.5:8080#frag'))
      .toBe('http://10.0.0.5:8080');
    // A path is silently dropped — documented, and the reason the value must be a
    // bare origin rather than a gateway mount point.
    expect(resolveIntranetBaseUrl(undefined, 'https://gw.corp/lobsterai')).toBe('https://gw.corp');
  });

  test('accepts hosts that the development override rejects', () => {
    // The whole point of this module: a real intranet host, HTTPS or plain HTTP,
    // with or without an explicit port, has to work in a packaged build.
    expect(resolveIntranetBaseUrl(undefined, 'https://lobsterai-server.intranet.corp'))
      .toBe('https://lobsterai-server.intranet.corp');
    expect(resolveIntranetBaseUrl(undefined, 'http://10.0.0.5')).toBe('http://10.0.0.5');
    expect(resolveIntranetBaseUrl(undefined, 'http://localhost:8080')).toBe('http://localhost:8080');
  });

  test('rejects values that are not an absolute URL', () => {
    for (const value of ['10.0.0.5:8080', 'lobsterai-server.corp', '/api', '10.0.0.5']) {
      expect(() => resolveIntranetBaseUrl(undefined, value)).toThrow('absolute URL');
    }
  });

  test('rejects non-HTTP(S) protocols', () => {
    for (const value of ['ftp://10.0.0.5', 'file:///tmp/server', 'ws://10.0.0.5:8080']) {
      expect(() => resolveIntranetBaseUrl(undefined, value)).toThrow('HTTP(S)');
    }
  });
});
