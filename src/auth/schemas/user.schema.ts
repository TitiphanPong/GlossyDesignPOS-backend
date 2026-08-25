import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';
import { USER_ROLES } from '../auth.constants';
import type { UserRole } from '../auth.constants';

export type UserDocument = HydratedDocument<User>;

@Schema({ timestamps: true })
export class User {
  @Prop({
    required: true,
    unique: true,
    index: true,
    trim: true,
    lowercase: true,
  })
  username: string;

  @Prop({ required: true, select: false })
  passwordHash: string;

  @Prop({ type: String, required: true, enum: USER_ROLES, default: 'staff' })
  role: UserRole;

  @Prop({ default: true, index: true })
  active: boolean;

  @Prop()
  lastLoginAt?: Date;
}

export const UserSchema = SchemaFactory.createForClass(User);
