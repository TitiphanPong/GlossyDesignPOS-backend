import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Subject, Observable, interval, merge, map } from 'rxjs';

interface ToObjectLike {
  toObject: () => unknown;
}

type CustomerEvent = { type: 'order'; payload: unknown } | { type: 'ping' };
export type CustomerSsePayload =
  | { type: 'ping'; ts: number }
  | { type: 'order'; payload: Record<string, unknown> | null };
export type CustomerSseMessage = { data: string };

@Injectable()
export class OrdersSseService implements OnModuleDestroy {
  private readonly stream$ = new Subject<CustomerEvent>();
  private readonly heartbeat$ = interval(15000).pipe(
    map(() => ({ type: 'ping' as const })),
  );

  onModuleDestroy() {
    this.stream$.complete();
  }

  asObservable(): Observable<CustomerSseMessage> {
    return merge(this.stream$, this.heartbeat$).pipe(
      map((evt) => ({ data: JSON.stringify(this.toPayload(evt)) })),
    );
  }

  emitOrder(orderOrNull: unknown) {
    const maybeDoc = orderOrNull as ToObjectLike | null;
    const lean =
      maybeDoc && typeof maybeDoc.toObject === 'function'
        ? maybeDoc.toObject()
        : orderOrNull;

    this.stream$.next({ type: 'order', payload: lean ?? null });
  }

  emitOrderAndAutoClear(order: unknown, ms = 7000) {
    this.emitOrder(order);
    setTimeout(() => this.emitOrder(null), ms);
  }

  private toPayload(event: CustomerEvent): CustomerSsePayload {
    if (event.type === 'ping') {
      return { type: 'ping', ts: Date.now() };
    }

    const payload =
      event.payload && typeof event.payload === 'object'
        ? (event.payload as Record<string, unknown>)
        : null;

    return { type: 'order', payload };
  }
}
