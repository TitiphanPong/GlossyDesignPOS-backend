import { ForbiddenException } from '@nestjs/common';
import { AuditService } from '../auth/audit.service';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';

describe('InventoryController', () => {
  const movement = { _id: '64b000000000000000000099' };

  function makeController() {
    const recordMovement = jest.fn().mockResolvedValue(movement);
    const inventoryService = {
      recordMovement,
    } as unknown as InventoryService;
    const auditService = {
      record: jest.fn().mockResolvedValue(true),
    } as unknown as AuditService;
    return {
      controller: new InventoryController(inventoryService, auditService),
      recordMovement,
    };
  }

  it('allows authenticated staff to record normal issue/use movement', async () => {
    const { controller, recordMovement } = makeController();

    await expect(
      controller.move(
        '64b000000000000000000002',
        { type: 'issue', quantity: 2, reason: 'use paper' },
        { user: { id: '1', username: 'staff', role: 'staff' } },
      ),
    ).resolves.toBe(movement);
    expect(recordMovement).toHaveBeenCalledTimes(1);
  });

  it('rejects manual adjustment from staff before changing stock', async () => {
    const { controller, recordMovement } = makeController();

    await expect(
      controller.move(
        '64b000000000000000000002',
        { type: 'adjustment_in', quantity: 2, reason: 'count correction' },
        { user: { id: '1', username: 'staff', role: 'staff' } },
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(recordMovement).not.toHaveBeenCalled();
  });

  it('allows manager manual adjustment', async () => {
    const { controller, recordMovement } = makeController();

    await expect(
      controller.move(
        '64b000000000000000000002',
        { type: 'adjustment_out', quantity: 1, reason: 'physical count' },
        { user: { id: '2', username: 'manager', role: 'manager' } },
      ),
    ).resolves.toBe(movement);
    expect(recordMovement).toHaveBeenCalledTimes(1);
  });
});
