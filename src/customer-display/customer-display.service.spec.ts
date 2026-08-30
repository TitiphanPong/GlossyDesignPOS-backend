import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Model } from 'mongoose';
import { CustomerDisplayService } from './customer-display.service';
import type { CustomerDisplaySessionDocument } from './customer-display.schema';

type FakeRow = {
  sessionId: string;
  tokenHash: string;
  createdBy: string;
  state: object | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  save: () => Promise<FakeRow>;
};

type FakeFilter = {
  sessionId?: string;
  tokenHash?: string;
  expiresAt?: { $gt: Date };
};

type FakeQuery = {
  select: () => FakeQuery;
  lean: () => FakeQuery;
  exec: () => Promise<FakeRow | null>;
};

function createFakeModel() {
  const rows: FakeRow[] = [];
  const model = {
    create(input: Record<string, unknown>) {
      const row = {} as FakeRow;
      Object.assign(row, {
        sessionId: String(input.sessionId),
        tokenHash: String(input.tokenHash),
        createdBy: String(input.createdBy),
        state: (input.state as object | null) ?? null,
        expiresAt: input.expiresAt as Date,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      row.save = () => {
        row.updatedAt = new Date();
        return Promise.resolve(row);
      };
      rows.push(row);
      return Promise.resolve(row);
    },
    findOne(filter: FakeFilter): FakeQuery {
      const execute = () => {
        const row =
          rows.find((candidate) => {
            if (filter.sessionId && candidate.sessionId !== filter.sessionId)
              return false;
            if (filter.tokenHash && candidate.tokenHash !== filter.tokenHash)
              return false;
            if (
              filter.expiresAt?.$gt &&
              candidate.expiresAt <= filter.expiresAt.$gt
            )
              return false;
            return true;
          }) ?? null;
        return Promise.resolve(row);
      };
      const query: FakeQuery = {
        select: () => query,
        lean: () => query,
        exec: execute,
      };
      return query;
    },
  };
  return model as unknown as Model<CustomerDisplaySessionDocument>;
}

function getSessionEventCount(service: CustomerDisplayService) {
  return (service as unknown as { sessionEvents: Map<string, unknown> })
    .sessionEvents.size;
}

describe('CustomerDisplayService', () => {
  it('isolates update ownership and exposes state only through the display token', async () => {
    const service = new CustomerDisplayService(createFakeModel());
    const session = await service.createSession('staff-a');

    await expect(
      service.updateState(session.sessionId, 'staff-b', null),
    ).rejects.toBeInstanceOf(ForbiddenException);

    await service.updateState(session.sessionId, 'staff-a', {
      total: 100,
      discount: 0,
      grandTotal: 100,
      payment: 'promptpay',
      status: 'pending',
      cart: [{ name: 'A4 print', qty: 2, totalPrice: 100 }],
      remainingTotal: 100,
    });
    const publicState = await service.getPublicState(session.displayToken);

    expect(publicState.sessionId).toBe(session.sessionId);
    expect(publicState.state).toMatchObject({
      grandTotal: 100,
      payment: 'promptpay',
    });
    await expect(service.getPublicState('wrong-token')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('clears customer state without deleting the pairing session', async () => {
    const service = new CustomerDisplayService(createFakeModel());
    const session = await service.createSession('staff-a');
    await service.updateState(session.sessionId, 'staff-a', null);
    const payload = await service.getPublicState(session.displayToken);
    expect(payload.state).toBeNull();
  });

  it('rotates one owned pairing and invalidates the previous public token immediately', async () => {
    const service = new CustomerDisplayService(createFakeModel());
    const original = await service.createSession('staff-a');
    const rotated = await service.rotateSession(original.sessionId, 'staff-a');

    expect(rotated.sessionId).toBe(original.sessionId);
    expect(rotated.displayToken).not.toBe(original.displayToken);
    await expect(
      service.getPublicState(original.displayToken),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.getPublicState(rotated.displayToken),
    ).resolves.toMatchObject({
      sessionId: original.sessionId,
    });
  });

  it('revokes only an owned pairing and makes its public token unusable', async () => {
    const service = new CustomerDisplayService(createFakeModel());
    const session = await service.createSession('staff-a');

    await expect(
      service.revokeSession(session.sessionId, 'staff-b'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    await expect(
      service.rotateSession(session.sessionId, 'staff-b'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    await expect(
      service.revokeSession(session.sessionId, 'staff-a'),
    ).resolves.toEqual({ sessionId: session.sessionId, revoked: true });
    await expect(
      service.getPublicState(session.displayToken),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('does not retain process-local Subjects for state updates without an SSE subscriber', async () => {
    const service = new CustomerDisplayService(createFakeModel());
    const session = await service.createSession('staff-a');

    await service.updateState(session.sessionId, 'staff-a', null);

    expect(getSessionEventCount(service)).toBe(0);
  });

  it('cleans the process-local Subject when the last SSE subscriber disconnects', async () => {
    const service = new CustomerDisplayService(createFakeModel());
    const session = await service.createSession('staff-a');

    const firstMessage = new Promise<void>((resolve, reject) => {
      const subscription = service.stream(session.displayToken).subscribe({
        next: () => {
          subscription.unsubscribe();
          resolve();
        },
        error: reject,
      });
    });
    await firstMessage;

    expect(getSessionEventCount(service)).toBe(0);
  });
});
