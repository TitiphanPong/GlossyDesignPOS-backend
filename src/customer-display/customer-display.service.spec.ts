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
});
