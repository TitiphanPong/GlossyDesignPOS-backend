import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthSession, AuthSessionSchema } from './schemas/auth-session.schema';
import { User, UserSchema } from './schemas/user.schema';
import { AuditEvent, AuditEventSchema } from './schemas/audit-event.schema';
import { AuditService } from './audit.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: AuthSession.name, schema: AuthSessionSchema },
      { name: AuditEvent.name, schema: AuditEventSchema },
    ]),
  ],
  controllers: [AuthController],
  providers: [AuthService, AuditService],
  exports: [AuthService, AuditService],
})
export class AuthModule {}
