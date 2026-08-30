import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { LineSignatureService } from './line-signature.service';

function configWith(secret?: string): ConfigService {
  return {
    get: jest.fn((key: string) =>
      key === 'LINE_CHANNEL_SECRET' ? secret : undefined,
    ),
  } as unknown as ConfigService;
}

describe('LineSignatureService', () => {
  const secret = 'line-test-secret';
  const rawBody = Buffer.from(
    JSON.stringify({ events: [{ type: 'message' }] }),
    'utf8',
  );

  it('accepts the HMAC-SHA256 signature generated from the exact raw body', () => {
    const service = new LineSignatureService(configWith(secret));
    const signature = createHmac('sha256', secret)
      .update(rawBody)
      .digest('base64');

    expect(service.isValid(rawBody, signature)).toBe(true);
    expect(() => service.assertValid(rawBody, signature)).not.toThrow();
  });

  it('rejects a signature generated from different bytes', () => {
    const service = new LineSignatureService(configWith(secret));
    const signature = createHmac('sha256', secret)
      .update(Buffer.from('{}'))
      .digest('base64');

    expect(service.isValid(rawBody, signature)).toBe(false);
    expect(() => service.assertValid(rawBody, signature)).toThrow(
      UnauthorizedException,
    );
  });

  it('fails closed when LINE credentials are not configured', () => {
    const service = new LineSignatureService(configWith());

    expect(() => service.assertValid(rawBody, 'anything')).toThrow(
      ServiceUnavailableException,
    );
  });
});
