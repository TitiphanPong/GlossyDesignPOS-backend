import { IsString, MinLength } from 'class-validator';

export class DeleteOrderDto {
  @IsString()
  @MinLength(1)
  password!: string;
}
