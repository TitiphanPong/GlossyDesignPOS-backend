import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Request,
  UnauthorizedException,
  Param,
  Patch,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public, Roles } from './auth.decorators';
import { AuthService } from './auth.service';
import { AuthenticatedUser } from './auth.types';
import { LoginDto } from './dto/login.dto';
import { CreateUserDto, UpdateUserDto } from './dto/manage-user.dto';

type AuthRequest = { user: AuthenticatedUser };

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  login(@Body() body: LoginDto) {
    return this.authService.login(body.username, body.password);
  }

  @Get('me')
  me(@Request() request: AuthRequest) {
    return { user: request.user };
  }

  @Post('logout')
  async logout(
    @Request() request: AuthRequest,
    @Headers('authorization') authorization?: string,
  ) {
    const token = authorization?.startsWith('Bearer ')
      ? authorization.slice(7).trim()
      : '';
    if (!token) throw new UnauthorizedException('Authentication required');
    await this.authService.logout(token, request.user);
    return { authenticated: false };
  }

  @Get('users')
  @Roles('admin')
  listUsers() {
    return this.authService.listUsers();
  }

  @Post('users')
  @Roles('admin')
  createUser(@Body() body: CreateUserDto, @Request() request: AuthRequest) {
    return this.authService.createUser(body, request.user);
  }

  @Patch('users/:id')
  @Roles('admin')
  updateUser(
    @Param('id') id: string,
    @Body() body: UpdateUserDto,
    @Request() request: AuthRequest,
  ) {
    return this.authService.updateUser(id, body, request.user);
  }

  @Get('audit')
  @Roles('admin')
  listAudit(@Query('limit') limit?: string) {
    const parsed = limit ? Number.parseInt(limit, 10) : undefined;
    return this.authService.listAuditEvents(
      typeof parsed === 'number' && Number.isFinite(parsed)
        ? parsed
        : undefined,
    );
  }
}
