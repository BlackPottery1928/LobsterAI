import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { BrowserCredentialAvailabilityReason } from '../../shared/browserCredentials/constants';
import {
  type BrowserCredentialCrypto,
  BrowserCredentialService,
  normalizeBrowserCredentialOrigin,
} from './browserCredentialService';

class TestCredentialCrypto implements BrowserCredentialCrypto {
  available = true;
  backend = 'kwallet6';

  isEncryptionAvailable(): boolean {
    return this.available;
  }

  getSelectedStorageBackend(): string {
    return this.backend;
  }

  encryptString(plainText: string): Buffer {
    return Buffer.from(`encrypted:${plainText}`, 'utf8');
  }

  decryptString(encrypted: Buffer): string {
    return encrypted.toString('utf8').replace(/^encrypted:/, '');
  }
}

describe('BrowserCredentialService', () => {
  let db: Database.Database;
  let encryption: TestCredentialCrypto;
  let service: BrowserCredentialService;

  beforeEach(() => {
    db = new Database(':memory:');
    encryption = new TestCredentialCrypto();
    service = new BrowserCredentialService(db, encryption, 'win32');
  });

  afterEach(() => {
    db.close();
  });

  test('normalizes secure origins and permits localhost HTTP only', () => {
    expect(normalizeBrowserCredentialOrigin('Example.com/login')).toBe('https://example.com');
    expect(normalizeBrowserCredentialOrigin('http://localhost:5175/login')).toBe('http://localhost:5175');
    expect(() => normalizeBrowserCredentialOrigin('http://example.com/login')).toThrow(/HTTPS/);
    expect(() => normalizeBrowserCredentialOrigin('ftp://example.com')).toThrow(/HTTPS/);
  });

  test('stores encrypted passwords and never exposes them in summaries', () => {
    const saved = service.save({
      origin: 'https://example.com/login',
      username: 'alice@example.com',
      password: 'correct horse battery staple',
    });

    expect(saved).toMatchObject({
      origin: 'https://example.com',
      username: 'alice@example.com',
    });
    expect(service.list()).toEqual([saved]);
    const stored = db.prepare('SELECT encrypted_password FROM browser_credentials WHERE id = ?')
      .get(saved.id) as { encrypted_password: Buffer };
    expect(stored.encrypted_password.toString('utf8')).toBe('encrypted:correct horse battery staple');
    expect(service.getSecret(saved.id, 'https://example.com/account').password)
      .toBe('correct horse battery staple');
  });

  test('updates the matching origin and username instead of creating duplicates', () => {
    const first = service.save({
      origin: 'example.com',
      username: 'Alice',
      password: 'first',
    });
    const second = service.save({
      origin: 'https://example.com/path',
      username: 'alice',
      password: 'second',
    });

    expect(second.id).toBe(first.id);
    expect(service.list()).toHaveLength(1);
    expect(service.getSecret(first.id, 'https://example.com').password).toBe('second');
  });

  test('refuses decryption for another origin', () => {
    const saved = service.save({
      origin: 'https://example.com',
      username: 'alice',
      password: 'secret',
    });
    expect(() => service.getSecret(saved.id, 'https://other.example.com')).toThrow(/does not match/);
  });

  test('reports unavailable or insecure OS storage', () => {
    encryption.available = false;
    expect(service.getAvailability()).toEqual({
      available: false,
      reason: BrowserCredentialAvailabilityReason.EncryptionUnavailable,
    });

    encryption.available = true;
    encryption.backend = 'basic_text';
    const linuxService = new BrowserCredentialService(db, encryption, 'linux');
    expect(linuxService.getAvailability()).toEqual({
      available: false,
      reason: BrowserCredentialAvailabilityReason.InsecureStorageBackend,
    });
  });
});
