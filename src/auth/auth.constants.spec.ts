import {
  AGENT_AUTH_SESSION_TTL_MS,
  AUTH_SESSION_TTL_MS,
  resolveAuthSessionTtlMs,
} from './auth.constants';

describe('resolveAuthSessionTtlMs', () => {
  it('keeps regular users on the 12-hour session TTL', () => {
    expect(resolveAuthSessionTtlMs('cashier', 'glossy-agent')).toBe(
      AUTH_SESSION_TTL_MS,
    );
  });

  it('grants only the configured agent username the 24-hour session TTL', () => {
    expect(resolveAuthSessionTtlMs('glossy-agent', ' GLOSSY-AGENT ')).toBe(
      AGENT_AUTH_SESSION_TTL_MS,
    );
  });

  it('falls back to the regular TTL when no agent username is configured', () => {
    expect(resolveAuthSessionTtlMs('glossy-agent')).toBe(AUTH_SESSION_TTL_MS);
  });
});
