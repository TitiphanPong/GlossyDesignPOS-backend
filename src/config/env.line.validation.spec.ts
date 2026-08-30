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

describe('LINE environment validation', () => {
  it('allows LINE integration to remain disabled when all LINE variables are absent', () => {
    expect(() => validateEnv({ ...REQUIRED_CONFIG })).not.toThrow();
  });

  it('accepts a complete Messaging API credential set', () => {
    expect(() =>
      validateEnv({
        ...REQUIRED_CONFIG,
        LINE_CHANNEL_ID: '1234567890',
        LINE_CHANNEL_SECRET: 'channel-secret',
        LINE_CHANNEL_ACCESS_TOKEN: 'channel-access-token',
      }),
    ).not.toThrow();
  });

  it('rejects partial LINE configuration', () => {
    expect(() =>
      validateEnv({
        ...REQUIRED_CONFIG,
        LINE_CHANNEL_ID: '1234567890',
        LINE_CHANNEL_SECRET: 'channel-secret',
      }),
    ).toThrow(
      'LINE_CHANNEL_ID, LINE_CHANNEL_SECRET and LINE_CHANNEL_ACCESS_TOKEN must be provided together',
    );
  });

  it('accepts a complete LINE Login credential pair', () => {
    expect(() =>
      validateEnv({
        ...REQUIRED_CONFIG,
        LINE_LOGIN_CHANNEL_ID: '2011330975',
        LINE_LOGIN_CHANNEL_SECRET: 'login-channel-secret',
      }),
    ).not.toThrow();
  });

  it('rejects a partial LINE Login configuration', () => {
    expect(() =>
      validateEnv({
        ...REQUIRED_CONFIG,
        LINE_LOGIN_CHANNEL_ID: '2011330975',
      }),
    ).toThrow(
      'LINE_LOGIN_CHANNEL_ID and LINE_LOGIN_CHANNEL_SECRET must be provided together',
    );
  });
});
