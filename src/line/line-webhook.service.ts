import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { LineMessagingService } from './line-messaging.service';

type UnknownRecord = Record<string, unknown>;

type LineWebhookPayload = {
  events: unknown[];
};

const CONNECTION_TEST_MESSAGES = new Set(['test', 'ping', 'ทดสอบ']);
const CONNECTION_SUCCESS_MESSAGE = 'เชื่อมต่อ Glossy Design สำเร็จ ✅';

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePayload(value: unknown): LineWebhookPayload {
  if (!isRecord(value) || !Array.isArray(value.events)) {
    throw new BadRequestException('Invalid LINE webhook payload');
  }
  return { events: value.events };
}

function stringField(record: UnknownRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

@Injectable()
export class LineWebhookService {
  private readonly logger = new Logger(LineWebhookService.name);

  constructor(private readonly messagingService: LineMessagingService) {}

  async handle(payload: unknown): Promise<void> {
    const { events } = parsePayload(payload);

    for (const event of events) {
      await this.handleEvent(event);
    }
  }

  private async handleEvent(value: unknown): Promise<void> {
    if (!isRecord(value)) {
      this.logger.warn('Ignored malformed LINE webhook event');
      return;
    }

    const type = stringField(value, 'type');
    switch (type) {
      case 'message':
        await this.handleMessageEvent(value);
        return;
      case 'follow':
        this.logger.log('Received LINE follow event');
        return;
      case 'postback':
        this.logger.log('Received LINE postback event');
        return;
      default:
        this.logger.debug(
          `Ignored LINE webhook event type: ${type ?? 'unknown'}`,
        );
    }
  }

  private async handleMessageEvent(event: UnknownRecord): Promise<void> {
    const message = event.message;
    if (!isRecord(message)) {
      this.logger.warn('Ignored LINE message event without message payload');
      return;
    }

    const messageType = stringField(message, 'type');
    if (messageType !== 'text') {
      this.logger.log(
        `Received LINE message event with type ${messageType ?? 'unknown'}`,
      );
      return;
    }

    this.logger.log('Received LINE text message event');

    const text = stringField(message, 'text')
      ?.trim()
      .toLocaleLowerCase('th-TH');
    const replyToken = stringField(event, 'replyToken');
    if (!text || !replyToken || !CONNECTION_TEST_MESSAGES.has(text)) return;

    try {
      await this.messagingService.replyText(
        replyToken,
        CONNECTION_SUCCESS_MESSAGE,
      );
    } catch (error) {
      this.logger.error(
        `Failed to send LINE connection-test reply: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
    }
  }
}

export const LINE_CONNECTION_SUCCESS_MESSAGE = CONNECTION_SUCCESS_MESSAGE;
