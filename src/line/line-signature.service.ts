import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

@Injectable()
export class LineSignatureService {
  private readonly channelSecret: string;

  constructor(configService: ConfigService) {
    this.channelSecret =
      configService.get<string>('LINE_CHANNEL_SECRET')?.trim() ?? '';
  }

  assertValid(rawBody: Buffer, signature?: string): void {
    if (!this.channelSecret) {
      throw new ServiceUnavailableException(
        'LINE integration is not configured',
      );
    }

    if (!signature || !this.isValid(rawBody, signature)) {
      throw new UnauthorizedException('Invalid LINE webhook signature');
    }
  }

  isValid(rawBody: Buffer, signature: string): boolean {
    if (!this.channelSecret || !signature) return false;

    const expected = createHmac('sha256', this.channelSecret)
      .update(rawBody)
      .digest();
    const actual = Buffer.from(signature, 'base64');

    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  }
}
