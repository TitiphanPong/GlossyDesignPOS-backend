import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

type LineVerifyResponse = {
  iss?: unknown;
  sub?: unknown;
  aud?: unknown;
  exp?: unknown;
  name?: unknown;
  picture?: unknown;
};

export type VerifiedLineIdentity = {
  userId: string;
  displayName: string;
  pictureUrl?: string;
};

@Injectable()
export class LineLoginService {
  constructor(private readonly configService: ConfigService) {}

  async verifyIdToken(idToken: string): Promise<VerifiedLineIdentity> {
    const channelId = this.configService
      .get<string>('LINE_LOGIN_CHANNEL_ID')
      ?.trim();
    if (!channelId) {
      throw new ServiceUnavailableException('LINE Login is not configured');
    }

    let response: Response;
    try {
      response = await fetch('https://api.line.me/oauth2/v2.1/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ id_token: idToken, client_id: channelId }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new ServiceUnavailableException(
        'LINE Login verification is temporarily unavailable',
      );
    }

    if (!response.ok) {
      throw new UnauthorizedException('Invalid or expired LINE login');
    }

    const payload = (await response.json()) as LineVerifyResponse;
    const userId = typeof payload.sub === 'string' ? payload.sub.trim() : '';
    const audience = typeof payload.aud === 'string' ? payload.aud.trim() : '';
    const issuer = typeof payload.iss === 'string' ? payload.iss.trim() : '';
    const expiresAt = typeof payload.exp === 'number' ? payload.exp : 0;

    if (
      !userId ||
      audience !== channelId ||
      issuer !== 'https://access.line.me' ||
      expiresAt <= Math.floor(Date.now() / 1000)
    ) {
      throw new UnauthorizedException('Invalid or expired LINE login');
    }

    const displayName =
      typeof payload.name === 'string' && payload.name.trim()
        ? payload.name.trim()
        : 'LINE Customer';
    const pictureUrl =
      typeof payload.picture === 'string' && payload.picture.trim()
        ? payload.picture.trim()
        : undefined;

    return { userId, displayName, pictureUrl };
  }
}
