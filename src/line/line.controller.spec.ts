import { BadRequestException } from '@nestjs/common';
import { IS_PUBLIC_KEY } from '../auth/auth.constants';
import { LineController } from './line.controller';
import { LineSignatureService } from './line-signature.service';
import { LineWebhookService } from './line-webhook.service';

describe('LineController', () => {
  function createController() {
    const assertValid = jest.fn();
    const handle = jest.fn().mockResolvedValue(undefined);
    const controller = new LineController(
      { assertValid } as unknown as LineSignatureService,
      { handle } as unknown as LineWebhookService,
    );
    return { controller, assertValid, handle };
  }

  it('keeps the webhook public while authenticating LINE with its signature', () => {
    const handler = Object.getOwnPropertyDescriptor(
      LineController.prototype,
      'webhook',
    )?.value as object | undefined;

    expect(handler).toBeDefined();
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler!)).toBe(true);
  });

  it('verifies the raw request body before processing webhook events', async () => {
    const { controller, assertValid, handle } = createController();
    const rawBody = Buffer.from('{"events":[]}');
    const body = { events: [] };

    await expect(
      controller.webhook({ rawBody } as never, 'line-signature', body),
    ).resolves.toEqual({ ok: true });

    expect(assertValid).toHaveBeenCalledWith(rawBody, 'line-signature');
    expect(handle).toHaveBeenCalledWith(body);
    expect(assertValid.mock.invocationCallOrder[0]).toBeLessThan(
      handle.mock.invocationCallOrder[0],
    );
  });

  it('fails closed when raw body capture is unavailable', async () => {
    const { controller, assertValid, handle } = createController();

    await expect(
      controller.webhook({} as never, 'line-signature', { events: [] }),
    ).rejects.toThrow(BadRequestException);
    expect(assertValid).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
  });
});
