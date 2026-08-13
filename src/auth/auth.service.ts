import {
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { isValidObjectId, Model } from 'mongoose';
import { AUTH_SESSION_TTL_MS } from './auth.constants';
import { AuthenticatedUser } from './auth.types';
import {
  AuthSession,
  AuthSessionDocument,
} from './schemas/auth-session.schema';
import { User, UserDocument } from './schemas/user.schema';
import { CreateUserDto, UpdateUserDto } from './dto/manage-user.dto';
import { AuditService } from './audit.service';
import { MongoServerError } from 'mongodb';

const scrypt = promisify(scryptCallback);

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(AuthSession.name)
    private readonly sessionModel: Model<AuthSessionDocument>,
    private readonly config: ConfigService,
    private readonly auditService: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    const username = this.config
      .get<string>('ADMIN_LOGIN_USERNAME')
      ?.trim()
      .toLowerCase();
    const password = this.config.get<string>('ADMIN_LOGIN_PASSWORD');
    if (!username || !password) return;

    const exists = await this.userModel.exists({ username });
    if (!exists) {
      await this.userModel.create({
        username,
        passwordHash: await this.hashPassword(password),
        role: 'admin',
        active: true,
      });
      this.logger.warn(
        `Bootstrapped admin user "${username}" from environment configuration`,
      );
      await this.auditService.record(null, 'auth.user.bootstrap', {
        type: 'user',
        id: username,
      });
    }
  }

  async login(
    usernameInput: string,
    password: string,
  ): Promise<{
    accessToken: string;
    expiresAt: string;
    user: AuthenticatedUser;
  }> {
    const username = usernameInput.trim().toLowerCase();
    const user = await this.userModel
      .findOne({ username, active: true })
      .select('+passwordHash')
      .exec();
    if (!user || !(await this.verifyPassword(password, user.passwordHash))) {
      await this.auditService.record(null, 'auth.login.failure', undefined, {
        username,
      });
      throw new UnauthorizedException('Invalid username or password');
    }

    const accessToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + AUTH_SESSION_TTL_MS);
    await Promise.all([
      this.sessionModel.create({
        userId: user._id,
        tokenHash: this.hashToken(accessToken),
        expiresAt,
      }),
      this.userModel
        .updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } })
        .exec(),
    ]);

    const authenticatedUser = this.toAuthenticatedUser(user);
    await this.auditService.record(authenticatedUser, 'auth.login.success', {
      type: 'session',
      id: this.hashToken(accessToken).slice(0, 16),
    });

    return {
      accessToken,
      expiresAt: expiresAt.toISOString(),
      user: authenticatedUser,
    };
  }

  async authenticate(accessToken: string): Promise<AuthenticatedUser | null> {
    const session = await this.sessionModel
      .findOne({
        tokenHash: this.hashToken(accessToken),
        revokedAt: null,
        expiresAt: { $gt: new Date() },
      })
      .exec();
    if (!session) return null;
    const user = await this.userModel
      .findOne({ _id: session.userId, active: true })
      .exec();
    return user ? this.toAuthenticatedUser(user) : null;
  }

  async logout(accessToken: string, actor: AuthenticatedUser): Promise<void> {
    await this.sessionModel
      .updateOne(
        { tokenHash: this.hashToken(accessToken), revokedAt: null },
        { $set: { revokedAt: new Date() } },
      )
      .exec();
    await this.auditService.record(actor, 'auth.logout');
  }

  async listUsers() {
    const users = await this.userModel
      .find()
      .select('username role active lastLoginAt createdAt updatedAt')
      .sort({ username: 1 })
      .exec();
    return users.map((user) => this.toUserResponse(user));
  }

  async createUser(dto: CreateUserDto, actor: AuthenticatedUser) {
    const username = dto.username.trim().toLowerCase();
    try {
      const user = await this.userModel.create({
        username,
        passwordHash: await this.hashPassword(dto.password),
        role: dto.role,
        active: true,
      });
      await this.auditService.record(
        actor,
        'auth.user.create',
        { type: 'user', id: user._id.toHexString() },
        { username, role: dto.role },
      );
      return this.toUserResponse(user);
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) {
        throw new ConflictException('Username already exists');
      }
      throw error;
    }
  }

  async updateUser(id: string, dto: UpdateUserDto, actor: AuthenticatedUser) {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid user id');
    if (
      id === actor.id &&
      (dto.active === false || (dto.role && dto.role !== 'admin'))
    ) {
      throw new BadRequestException(
        'An admin cannot deactivate or demote their own account',
      );
    }

    const existing = await this.userModel.findById(id).exec();
    if (!existing) throw new NotFoundException('User not found');
    const removesAdminAccess =
      existing.role === 'admin' &&
      existing.active &&
      (dto.active === false || (dto.role && dto.role !== 'admin'));
    if (removesAdminAccess) {
      const activeAdminCount = await this.userModel.countDocuments({
        role: 'admin',
        active: true,
      });
      if (activeAdminCount <= 1) {
        throw new BadRequestException(
          'The last active admin cannot be disabled or demoted',
        );
      }
    }

    const update: Record<string, unknown> = {};
    if (dto.password)
      update.passwordHash = await this.hashPassword(dto.password);
    if (dto.role) update.role = dto.role;
    if (typeof dto.active === 'boolean') update.active = dto.active;
    if (!Object.keys(update).length)
      throw new BadRequestException('No user changes supplied');

    const user = await this.userModel
      .findByIdAndUpdate(
        existing._id,
        { $set: update },
        { new: true, runValidators: true },
      )
      .exec();
    if (!user) throw new NotFoundException('User not found');

    if (dto.password || dto.active === false) {
      await this.sessionModel
        .updateMany(
          { userId: user._id, revokedAt: null },
          { $set: { revokedAt: new Date() } },
        )
        .exec();
    }
    await this.auditService.record(
      actor,
      'auth.user.update',
      { type: 'user', id: user._id.toHexString() },
      {
        username: user.username,
        ...(dto.role ? { role: dto.role } : {}),
        ...(typeof dto.active === 'boolean' ? { active: dto.active } : {}),
        passwordChanged: Boolean(dto.password),
      },
    );
    return this.toUserResponse(user);
  }

  async listAuditEvents(limit?: number) {
    return this.auditService.list(limit);
  }

  private async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = (await scrypt(password, salt, 64)) as Buffer;
    return `scrypt:${salt.toString('base64url')}:${derived.toString('base64url')}`;
  }

  private async verifyPassword(
    password: string,
    encoded: string,
  ): Promise<boolean> {
    const [algorithm, saltText, hashText] = encoded.split(':');
    if (algorithm !== 'scrypt' || !saltText || !hashText) return false;
    const expected = Buffer.from(hashText, 'base64url');
    const actual = (await scrypt(
      password,
      Buffer.from(saltText, 'base64url'),
      expected.length,
    )) as Buffer;
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private toAuthenticatedUser(user: UserDocument): AuthenticatedUser {
    return {
      id: user._id.toHexString(),
      username: user.username,
      role: user.role,
    };
  }

  private toUserResponse(user: UserDocument) {
    return {
      id: user._id.toHexString(),
      username: user.username,
      role: user.role,
      active: user.active,
      lastLoginAt: user.lastLoginAt ?? null,
    };
  }
}
