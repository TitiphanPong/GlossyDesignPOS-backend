import { Module } from '@nestjs/common';
import { LineController } from './line.controller';
import { LineLoginService } from './line-login.service';
import { LineMessagingService } from './line-messaging.service';
import { LineSignatureService } from './line-signature.service';
import { LineWebhookService } from './line-webhook.service';

@Module({
  controllers: [LineController],
  providers: [
    LineLoginService,
    LineMessagingService,
    LineSignatureService,
    LineWebhookService,
  ],
  exports: [LineLoginService],
})
export class LineModule {}
