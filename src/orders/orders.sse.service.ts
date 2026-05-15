import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Subject, Observable, interval, merge, map } from 'rxjs';

interface ToObjectLike {
  toObject: () => unknown;
}

type CustomerEvent = { type: 'order'; payload: unknown } | { type: 'ping' };

@Injectable()
export class OrdersSseService implements OnModuleDestroy {
  private readonly stream$ = new Subject<CustomerEvent>();
  private readonly heartbeat$ = interval(15000).pipe(
    map(() => ({ type: 'ping' as const })),
  );

  onModuleDestroy() {
    this.stream$.complete();
  }

  asObservable(): Observable<{ data: string }> {
    return merge(this.stream$, this.heartbeat$).pipe(
      map((evt) => {
        if (evt.type === 'ping') {
          return { data: JSON.stringify({ type: 'ping', ts: Date.now() }) };
        }

        return { data: JSON.stringify(evt.payload ?? null) };
      }),
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
}
