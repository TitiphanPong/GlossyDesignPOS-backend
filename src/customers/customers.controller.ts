import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Request,
} from '@nestjs/common';
import { AuditService } from '../auth/audit.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { CustomersService } from './customers.service';
import {
  CreateCustomerDto,
  ListCustomersQueryDto,
  UpdateCustomerDto,
} from './dto/customer.dto';

type AuthRequest = { user?: AuthenticatedUser };

@Controller('customers')
export class CustomersController {
  constructor(
    private readonly customersService: CustomersService,
    private readonly auditService: AuditService,
  ) {}

  @Get()
  list(@Query() query: ListCustomersQueryDto) {
    return this.customersService.list(query);
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.customersService.detail(id);
  }

  @Post()
  async create(
    @Body() body: CreateCustomerDto,
    @Request() request: AuthRequest,
  ) {
    const created = await this.customersService.create(body);
    await this.auditService.record(request.user ?? null, 'customer.create', {
      type: 'customer',
      id: created._id.toString(),
    });
    return created;
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: UpdateCustomerDto,
    @Request() request: AuthRequest,
  ) {
    const updated = await this.customersService.update(id, body);
    await this.auditService.record(request.user ?? null, 'customer.update', {
      type: 'customer',
      id,
    });
    return updated;
  }
}
