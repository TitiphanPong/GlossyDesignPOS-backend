import {
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  Query,
  Request,
  Sse,
  Param,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Observable } from 'rxjs';
import { Public } from '../auth/auth.decorators';
import { AuthenticatedUser } from '../auth/auth.types';
import {
  CustomerDisplayService,
  CustomerDisplaySseMessage,
} from './customer-display.service';
import { UpdateCustomerDisplayStateDto } from './customer-display.dto';

type AuthRequest = { user?: AuthenticatedUser };

@Controller('customer-display')
export class CustomerDisplayController {
  constructor(
    private readonly customerDisplayService: CustomerDisplayService,
  ) {}

  @Post('sessions')
  createSession(@Request() request: AuthRequest) {
    if (!request.user) throw new Error('Authenticated user is required');
    return this.customerDisplayService.createSession(request.user.id);
  }

  @Post('sessions/:sessionId/rotate')
  rotateSession(
    @Param('sessionId') sessionId: string,
    @Request() request: AuthRequest,
  ) {
    if (!request.user) throw new Error('Authenticated user is required');
    return this.customerDisplayService.rotateSession(
      sessionId,
      request.user.id,
    );
  }

  @Delete('sessions/:sessionId')
  revokeSession(
    @Param('sessionId') sessionId: string,
    @Request() request: AuthRequest,
  ) {
    if (!request.user) throw new Error('Authenticated user is required');
    return this.customerDisplayService.revokeSession(
      sessionId,
      request.user.id,
    );
  }

  @Patch('sessions/:sessionId/state')
  updateState(
    @Param('sessionId') sessionId: string,
    @Body() body: UpdateCustomerDisplayStateDto,
    @Request() request: AuthRequest,
  ) {
    if (!request.user) throw new Error('Authenticated user is required');
    return this.customerDisplayService.updateState(
      sessionId,
      request.user.id,
      body.state,
    );
  }

  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Get('state')
  getState(@Query('token') token: string) {
    return this.customerDisplayService.getPublicState(token ?? '');
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Sse('events')
  events(@Query('token') token: string): Observable<CustomerDisplaySseMessage> {
    return this.customerDisplayService.stream(token ?? '');
  }
}
