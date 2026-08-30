import { Module } from '@nestjs/common';
import { LineController } from './line.controller';
import { LineMessagingService } from './line-messaging.service';
import { LineSignatureService } from './line-signature.service';
import { LineWebhookService } from './line-webhook.service';

@Module({
  controllers: [LineController],
  providers: [LineMessagingService, LineSignatureService, LineWebhookService],
})
export class LineModule {}
