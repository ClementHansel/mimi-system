import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

describe('loadConfig', () => {
  it('defaults to SIMULATE=false with no pairing token when the env is empty', () => {
    const config = loadConfig({});
    expect(config.simulate).toBe(false);
    expect(config.pairingToken).toBe('');
    expect(config.cloudUrl).toBe('http://localhost:4000');
    expect(config.healthPort).toBe(4010);
    expect(config.databaseUrl).toBeUndefined();
  });

  it('SIMULATE=true supplies a default pairing token so the app can start with zero config', () => {
    const config = loadConfig({ SIMULATE: 'true' });
    expect(config.simulate).toBe(true);
    expect(config.pairingToken).toBe('simulate-token');
  });

  it('reads the exact env var names wired in docker-compose.dev.yml / .env.example', () => {
    const config = loadConfig({
      SIMULATE: 'true',
      BRANCH_NODE_CLOUD_URL: 'https://cloud.example.com',
      BRANCH_NODE_PAIRING_TOKEN: 'tok-123',
      BRANCH_NODE_HEALTH_PORT: '9999',
    });
    expect(config.cloudUrl).toBe('https://cloud.example.com');
    expect(config.pairingToken).toBe('tok-123');
    expect(config.healthPort).toBe(9999);
  });

  it('parses boolean-ish SIMULATE values permissively', () => {
    expect(loadConfig({ SIMULATE: '1' }).simulate).toBe(true);
    expect(loadConfig({ SIMULATE: 'yes' }).simulate).toBe(true);
    expect(loadConfig({ SIMULATE: 'false' }).simulate).toBe(false);
    expect(loadConfig({ SIMULATE: '0' }).simulate).toBe(false);
  });

  it('only wires a database URL when explicitly set', () => {
    expect(loadConfig({ BRANCH_NODE_DATABASE_URL: 'postgresql://x' }).databaseUrl).toBe(
      'postgresql://x',
    );
    expect(loadConfig({}).databaseUrl).toBeUndefined();
  });
});
