import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const LINE_REPLY_ENDPOINT = 'https://api.line.me/v2/bot/message/reply';

@Injectable()
export class LineMessagingService {
  private readonly logger = new Logger(LineMessagingService.name);
  private readonly accessToken: string;

  constructor(configService: ConfigService) {
    this.accessToken =
      configService.get<string>('LINE_CHANNEL_ACCESS_TOKEN')?.trim() ?? '';
  }

  async replyText(replyToken: string, text: string): Promise<void> {
    if (!this.accessToken) {
      throw new ServiceUnavailableException(
        'LINE integration is not configured',
      );
    }

    let response: Response;
    try {
      response = await fetch(LINE_REPLY_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          replyToken,
          messages: [{ type: 'text', text }],
        }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      this.logger.error(
        `LINE Reply API request failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
      throw new BadGatewayException('LINE Reply API request failed');
    }

    if (!response.ok) {
      this.logger.error(`LINE Reply API returned HTTP ${response.status}`);
      throw new BadGatewayException('LINE Reply API rejected the request');
    }
  }
}
