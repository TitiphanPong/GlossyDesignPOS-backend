import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LineLoginService } from './line-login.service';

function config(channelId = '2011330975'): ConfigService {
  return {
    get: jest.fn((key: string) =>
      key === 'LINE_LOGIN_CHANNEL_ID' ? channelId : undefined,
    ),
  } as unknown as ConfigService;
}

describe('LineLoginService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('verifies an ID token with the LINE Login channel and returns trusted identity', async () => {
    const now = Math.floor(Date.now() / 1000);
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          iss: 'https://access.line.me',
          sub: 'U1234567890abcdef',
          aud: '2011330975',
          exp: now + 300,
          name: 'Glossy Customer',
          picture: 'https://profile.line-scdn.net/example',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const service = new LineLoginService(config());

    await expect(service.verifyIdToken('id-token-value')).resolves.toEqual({
      userId: 'U1234567890abcdef',
      displayName: 'Glossy Customer',
      pictureUrl: 'https://profile.line-scdn.net/example',
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(URLSearchParams);
    const encodedBody =
      init?.body instanceof URLSearchParams ? init.body.toString() : '';
    expect(encodedBody).toContain('id_token=id-token-value');
    expect(encodedBody).toContain('client_id=2011330975');
  });

  it('rejects LINE responses for a different audience or expired token', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          iss: 'https://access.line.me',
          sub: 'U123',
          aud: 'different-channel',
          exp: Math.floor(Date.now() / 1000) - 1,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const service = new LineLoginService(config());

    await expect(service.verifyIdToken('id-token-value')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects an invalid token returned by LINE', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 400 }));
    const service = new LineLoginService(config());

    await expect(service.verifyIdToken('bad-token-value')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('fails closed when LINE Login is not configured', async () => {
    const service = new LineLoginService(config(''));

    await expect(service.verifyIdToken('id-token-value')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});
