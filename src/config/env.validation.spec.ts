import 'reflect-metadata';
import { validateEnv } from './env.validation';

const REQUIRED_CONFIG = {
  FRONTEND_ORIGIN: 'http://localhost:3000',
  AWS_REGION: 'ap-southeast-1',
  AWS_ACCESS_KEY_ID: 'test-access-key',
  AWS_SECRET_ACCESS_KEY: 'test-secret-key',
  AWS_S3_BUCKET_PRIVATE: 'test-private-bucket',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/glossy-pos-test',
};

describe('validateEnv', () => {
  it('accepts a deployment with all Agent login variables unset', () => {
    expect(() => validateEnv({ ...REQUIRED_CONFIG })).not.toThrow();
  });

  it('accepts a complete Agent login pair with each supported role', () => {
    for (const role of ['staff', 'manager', 'admin']) {
      expect(() =>
        validateEnv({
          ...REQUIRED_CONFIG,
          AGENT_LOGIN_USERNAME: 'glossy-agent',
          AGENT_LOGIN_PASSWORD: 'agent-password-secret',
          AGENT_LOGIN_ROLE: role,
        }),
      ).not.toThrow();
    }
  });

  it.each([
    {
      AGENT_LOGIN_USERNAME: 'glossy-agent',
    },
    {
      AGENT_LOGIN_PASSWORD: 'agent-password-secret',
    },
  ])('rejects an incomplete Agent username/password pair', (agentConfig) => {
    expect(() =>
      validateEnv({
        ...REQUIRED_CONFIG,
        ...agentConfig,
      }),
    ).toThrow(
      'AGENT_LOGIN_USERNAME and AGENT_LOGIN_PASSWORD must be provided together',
    );
  });

  it('rejects an unsupported Agent role instead of silently falling back to staff', () => {
    expect(() =>
      validateEnv({
        ...REQUIRED_CONFIG,
        AGENT_LOGIN_USERNAME: 'glossy-agent',
        AGENT_LOGIN_PASSWORD: 'agent-password-secret',
        AGENT_LOGIN_ROLE: 'owner',
      }),
    ).toThrow(/AGENT_LOGIN_ROLE/);
  });

  it('does not include the Agent password value in validation errors', () => {
    const secret = 'do-not-leak-this-agent-password';

    try {
      validateEnv({
        ...REQUIRED_CONFIG,
        AGENT_LOGIN_USERNAME: 'glossy-agent',
        AGENT_LOGIN_PASSWORD: secret,
        AGENT_LOGIN_ROLE: 'owner',
      });
      throw new Error('Expected Agent login validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(secret);
    }
  });
});
