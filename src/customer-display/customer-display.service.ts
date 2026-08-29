import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Model } from 'mongoose';
import {
  interval,
  map,
  merge,
  Observable,
  startWith,
  Subject,
  switchMap,
  from,
  distinctUntilChanged,
} from 'rxjs';
import {
  CustomerDisplaySession,
  CustomerDisplaySessionDocument,
} from './customer-display.schema';
import { CustomerDisplayStateDto } from './customer-display.dto';

export type CustomerDisplaySseMessage = { data: string };

type DisplayEventPayload = {
  type: 'state';
  state: CustomerDisplayStateDto | null;
  sessionId: string;
  updatedAt: string;
};

@Injectable()
export class CustomerDisplayService {
  private readonly sessionEvents = new Map<string, Subject<void>>();

  constructor(
    @InjectModel(CustomerDisplaySession.name)
    private readonly sessionModel: Model<CustomerDisplaySessionDocument>,
  ) {}

  async createSession(actorId: string) {
    const sessionId = randomUUID();
    const displayToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);
    await this.sessionModel.create({
      sessionId,
      tokenHash: this.hashToken(displayToken),
      createdBy: actorId,
      state: null,
      expiresAt,
    });
    return { sessionId, displayToken, expiresAt: expiresAt.toISOString() };
  }

  async updateState(
    sessionId: string,
    actorId: string,
    state: CustomerDisplayStateDto | null | undefined,
  ) {
    const session = await this.sessionModel
      .findOne({ sessionId, expiresAt: { $gt: new Date() } })
      .select('+tokenHash')
      .exec();
    if (!session)
      throw new NotFoundException(
        'Customer display session not found or expired',
      );
    if (session.createdBy !== actorId)
      throw new ForbiddenException(
        'Customer display session belongs to another signed-in user',
      );

    session.state = state ? { ...state } : null;
    await session.save();
    this.getSubject(sessionId).next();
    return {
      sessionId,
      updatedAt: session.updatedAt?.toISOString?.() ?? new Date().toISOString(),
    };
  }

  async getPublicState(displayToken: string): Promise<DisplayEventPayload> {
    const session = await this.findByDisplayToken(displayToken);
    return this.toPayload(session);
  }

  stream(displayToken: string): Observable<CustomerDisplaySseMessage> {
    const tokenHash = this.hashToken(displayToken);
    const sessionIdPromise = this.sessionModel
      .findOne({ tokenHash, expiresAt: { $gt: new Date() } })
      .select('sessionId')
      .lean()
      .exec()
      .then((session) => session?.sessionId ?? null);

    return from(sessionIdPromise).pipe(
      switchMap((sessionId) => {
        if (!sessionId)
          throw new NotFoundException(
            'Customer display session not found or expired',
          );
        const localEvents$ = this.getSubject(sessionId).pipe(map(() => 0));
        const refresh$ = interval(3000).pipe(startWith(0));
        return merge(localEvents$, refresh$).pipe(
          switchMap(() => from(this.readSessionById(sessionId))),
          map((session) => this.toPayload(session)),
          distinctUntilChanged(
            (a, b) => JSON.stringify(a) === JSON.stringify(b),
          ),
          map((payload) => ({ data: JSON.stringify(payload) })),
        );
      }),
    );
  }

  private async findByDisplayToken(
    displayToken: string,
  ): Promise<CustomerDisplaySessionDocument> {
    const session = await this.sessionModel
      .findOne({
        tokenHash: this.hashToken(displayToken),
        expiresAt: { $gt: new Date() },
      })
      .exec();
    if (!session)
      throw new NotFoundException(
        'Customer display session not found or expired',
      );
    return session;
  }

  private async readSessionById(
    sessionId: string,
  ): Promise<CustomerDisplaySessionDocument> {
    const session = await this.sessionModel
      .findOne({ sessionId, expiresAt: { $gt: new Date() } })
      .exec();
    if (!session)
      throw new NotFoundException(
        'Customer display session not found or expired',
      );
    return session;
  }

  private toPayload(
    session: CustomerDisplaySessionDocument,
  ): DisplayEventPayload {
    return {
      type: 'state',
      state: (session.state ?? null) as CustomerDisplayStateDto | null,
      sessionId: session.sessionId,
      updatedAt: session.updatedAt?.toISOString?.() ?? new Date().toISOString(),
    };
  }

  private hashToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private getSubject(sessionId: string) {
    let subject = this.sessionEvents.get(sessionId);
    if (!subject) {
      subject = new Subject<void>();
      this.sessionEvents.set(sessionId, subject);
    }
    return subject;
  }
}
