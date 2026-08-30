import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Model } from 'mongoose';
import {
  distinctUntilChanged,
  finalize,
  from,
  interval,
  map,
  merge,
  Observable,
  startWith,
  Subject,
  switchMap,
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

const CUSTOMER_DISPLAY_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const CUSTOMER_DISPLAY_REFRESH_MS = 3000;

@Injectable()
export class CustomerDisplayService {
  private readonly sessionEvents = new Map<string, Subject<void>>();

  constructor(
    @InjectModel(CustomerDisplaySession.name)
    private readonly sessionModel: Model<CustomerDisplaySessionDocument>,
  ) {}

  async createSession(actorId: string) {
    const sessionId = randomUUID();
    const displayToken = this.generateDisplayToken();
    const expiresAt = this.nextExpiry();
    await this.sessionModel.create({
      sessionId,
      tokenHash: this.hashToken(displayToken),
      createdBy: actorId,
      state: null,
      expiresAt,
    });
    return { sessionId, displayToken, expiresAt: expiresAt.toISOString() };
  }

  async rotateSession(sessionId: string, actorId: string) {
    const session = await this.findOwnedActiveSession(sessionId, actorId);
    const displayToken = this.generateDisplayToken();
    const expiresAt = this.nextExpiry();
    session.tokenHash = this.hashToken(displayToken);
    session.expiresAt = expiresAt;
    await session.save();

    // Force every connection using the previous capability to revalidate now.
    // The old token is already invalid in Mongo before this signal is emitted.
    this.terminateLocalStreams(sessionId);

    return { sessionId, displayToken, expiresAt: expiresAt.toISOString() };
  }

  async revokeSession(sessionId: string, actorId: string) {
    const session = await this.findOwnedActiveSession(sessionId, actorId);
    session.state = null;
    session.expiresAt = new Date(0);
    await session.save();

    // TTL cleanup may happen later, but the public capability is invalid now.
    this.terminateLocalStreams(sessionId);
    return { sessionId, revoked: true };
  }

  async updateState(
    sessionId: string,
    actorId: string,
    state: CustomerDisplayStateDto | null | undefined,
  ) {
    const session = await this.findOwnedActiveSession(sessionId, actorId);
    session.state = state ? { ...state } : null;
    await session.save();

    // Do not allocate a Subject just because checkout state changed. A Subject is
    // created only while at least one local SSE subscriber actually needs it.
    this.sessionEvents.get(sessionId)?.next();
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

        const subject = this.getSubject(sessionId);
        const localEvents$ = subject.pipe(map(() => 0));
        const refresh$ = interval(CUSTOMER_DISPLAY_REFRESH_MS).pipe(
          startWith(0),
        );
        return merge(localEvents$, refresh$).pipe(
          // Revalidate the public capability on every local signal/refresh. This is
          // what makes revoke/rotate terminate an already-open old-token stream.
          switchMap(() =>
            from(this.readSessionByToken(displayToken, sessionId)),
          ),
          map((session) => this.toPayload(session)),
          distinctUntilChanged(
            (a, b) => JSON.stringify(a) === JSON.stringify(b),
          ),
          map((payload) => ({ data: JSON.stringify(payload) })),
          finalize(() => this.releaseSubject(sessionId, subject)),
        );
      }),
    );
  }

  private async findOwnedActiveSession(
    sessionId: string,
    actorId: string,
  ): Promise<CustomerDisplaySessionDocument> {
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
    return session;
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

  private async readSessionByToken(
    displayToken: string,
    expectedSessionId: string,
  ): Promise<CustomerDisplaySessionDocument> {
    const session = await this.findByDisplayToken(displayToken);
    if (session.sessionId !== expectedSessionId)
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

  private generateDisplayToken() {
    return randomBytes(32).toString('base64url');
  }

  private nextExpiry() {
    return new Date(Date.now() + CUSTOMER_DISPLAY_SESSION_TTL_MS);
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

  private releaseSubject(sessionId: string, subject: Subject<void>) {
    if (this.sessionEvents.get(sessionId) !== subject || subject.observed)
      return;
    subject.complete();
    this.sessionEvents.delete(sessionId);
  }

  private terminateLocalStreams(sessionId: string) {
    const subject = this.sessionEvents.get(sessionId);
    if (!subject) return;
    subject.next();
    subject.complete();
    this.sessionEvents.delete(sessionId);
  }
}
