import { Injectable } from '@nestjs/common';
import generatePayload from 'promptpay-qr';
import * as QR from 'qrcode';

@Injectable()
export class PaymentsService {
  async createPromptPayQR(ref: string, amount: number) {
    const id = process.env.PROMPTPAY_ID;
    if (!id) throw new Error('PROMPTPAY_ID is not set');
    const payload = generatePayload(id, { amount });
    const dataURL = await QR.toDataURL(payload, { margin: 1, scale: 6 });
    return { ref, amount, payload, dataURL };
  }
}