import { Body, Controller, Post } from '@nestjs/common';
import { IsNumber, IsString, Min } from 'class-validator';
import { PaymentsService } from './payments.service';

class PromptPayDto {
  @IsString()
  ref!: string; // orderId หรือรหัสบิล

  @IsNumber()
  @Min(1)
  amount!: number; // จำนวนเงิน (THB)
}

@Controller('payments')
export class PaymentsController {
  constructor(private readonly svc: PaymentsService) {}

  @Post('promptpay')
  createQR(@Body() body: PromptPayDto) {
    return this.svc.createPromptPayQR(body.ref, body.amount);
  }
}
