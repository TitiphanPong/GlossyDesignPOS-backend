import { Body, Controller, Post } from '@nestjs/common';
import { IsBoolean, IsInt, Min } from 'class-validator';

class EvaluateDto {
  @IsInt() @Min(1)
  pages!: number;

  @IsBoolean()
  duplex!: boolean; // ตัวอย่าง: ยังไม่คิดผลต่างจริงในสูตรง่าย

  @IsBoolean()
  grayscale!: boolean; // ขาวดำลดราคา

  @IsInt() @Min(1)
  qty!: number;
}

@Controller('pricing')
export class PricingController {
  @Post('evaluate')
  evaluate(@Body() b: EvaluateDto) {
    const rateColor = 2.5; // THB/หน้า (ตัวอย่าง)
    const rateBW = 1.0;    // THB/หน้า (ตัวอย่าง)
    const rate = b.grayscale ? rateBW : rateColor;
    const unit = b.pages * rate; // สูตรง่ายๆ: หน้า x rate
    const subtotal = unit * b.qty;
    return { unit, subtotal, currency: 'THB' };
  }
}