import { BadGatewayException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LineMessagingService } from './line-messaging.service';

function configWithToken(token = 'line-access-token'): ConfigService {
  return {
    get: jest.fn((key: string) =>
      key === 'LINE_CHANNEL_ACCESS_TOKEN' ? token : undefined,
    ),
  } as unknown as ConfigService;
}

describe('LineMessagingService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends a Reply API request with the configured bearer token', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({ ok: true, status: 200 } as Response);
    const service = new LineMessagingService(configWithToken());

    await service.replyText('reply-token-1', 'เชื่อมต่อสำเร็จ');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.line.me/v2/bot/message/reply');
    expect(request?.method).toBe('POST');
    expect(request?.headers).toEqual({
      Authorization: 'Bearer line-access-token',
      'Content-Type': 'application/json',
    });
    expect(request?.body).toBe(
      JSON.stringify({
        replyToken: 'reply-token-1',
        messages: [{ type: 'text', text: 'เชื่อมต่อสำเร็จ' }],
      }),
    );
  });

  it('fails with a gateway error when LINE rejects the reply', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({ ok: false, status: 401 } as Response);
    const service = new LineMessagingService(configWithToken());

    await expect(service.replyText('reply-token-1', 'test')).rejects.toThrow(
      BadGatewayException,
    );
  });
});
