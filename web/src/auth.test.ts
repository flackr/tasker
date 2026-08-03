import { beforeEach, describe, expect, it } from 'vitest';
import { clearCredentials, createBasicAuthHeader, loadCredentials, saveCredentials } from './auth';

describe('auth', () => {
  beforeEach(async () => {
    indexedDB.deleteDatabase('tasker-db');
  });

  it('creates a basic auth header', () => {
    expect(createBasicAuthHeader({ baseUrl: 'https://cloud.example.com', username: 'alice', appPassword: 'secret' })).toBe(
      'Basic YWxpY2U6c2VjcmV0',
    );
  });

  it('persists credentials', async () => {
    const credentials = { baseUrl: 'https://cloud.example.com', username: 'alice', appPassword: 'secret' };
    await saveCredentials(credentials);
    await expect(loadCredentials()).resolves.toEqual(credentials);
    await clearCredentials();
    await expect(loadCredentials()).resolves.toBeUndefined();
  });
});
