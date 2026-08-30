import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../auth/auth.decorators';
import { LineSignatureService } from './line-signature.service';
import { LineWebhookService } from './line-webhook.service';

type LineWebhookRequest = Request & { rawBody?: Buffer };

@Controller('line')
export class LineController {
  constructor(
    private readonly signatureService: LineSignatureService,
    private readonly webhookService: LineWebhookService,
  ) {}

  @Public()
  @SkipThrottle()
  @Post('webhook')
  @HttpCode(200)
  async webhook(
    @Req() request: LineWebhookRequest,
    @Headers('x-line-signature') signature: string | undefined,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    if (!request.rawBody) {
      throw new BadRequestException('LINE webhook raw body is unavailable');
    }

    this.signatureService.assertValid(request.rawBody, signature);
    await this.webhookService.handle(body);

    return { ok: true };
  }
}
