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
});
