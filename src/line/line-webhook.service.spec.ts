import { BadRequestException } from '@nestjs/common';
import { LineMessagingService } from './line-messaging.service';
import {
  LINE_CONNECTION_SUCCESS_MESSAGE,
  LineWebhookService,
} from './line-webhook.service';

describe('LineWebhookService', () => {
  function createService() {
    const replyText = jest.fn().mockResolvedValue(undefined);
    const messagingService = { replyText } as unknown as LineMessagingService;
    return { service: new LineWebhookService(messagingService), replyText };
  }

  it('replies only to explicit Phase 1 connection-test text messages', async () => {
    const { service, replyText } = createService();

    await service.handle({
      events: [
        {
          type: 'message',
          replyToken: 'reply-token-1',
          message: { type: 'text', text: 'ทดสอบ' },
        },
      ],
    });

    expect(replyText).toHaveBeenCalledWith(
      'reply-token-1',
      LINE_CONNECTION_SUCCESS_MESSAGE,
    );
  });

  it('does not hijack normal customer chat during the connection phase', async () => {
    const { service, replyText } = createService();

    await service.handle({
      events: [
        {
          type: 'message',
          replyToken: 'reply-token-2',
          message: { type: 'text', text: 'สอบถามราคานามบัตรครับ' },
        },
        { type: 'follow', replyToken: 'follow-token' },
        { type: 'postback', replyToken: 'postback-token' },
      ],
    });

    expect(replyText).not.toHaveBeenCalled();
  });

  it('acknowledges a valid webhook even when the temporary test reply fails', async () => {
    const replyText = jest
      .fn()
      .mockRejectedValue(new Error('LINE unavailable'));
    const service = new LineWebhookService({
      replyText,
    } as unknown as LineMessagingService);

    await expect(
      service.handle({
        events: [
          {
            type: 'message',
            replyToken: 'reply-token-3',
            message: { type: 'text', text: 'test' },
          },
        ],
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects malformed webhook payloads after signature verification', async () => {
    const { service } = createService();

    await expect(service.handle({ invalid: true })).rejects.toThrow(
      BadRequestException,
    );
  });
});
