// src/orders/orders.sse.service.ts
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Subject, Observable, interval, merge, map } from 'rxjs';

type CustomerEvent = { type: 'order'; payload: any | null } | { type: 'ping' };

@Injectable()
export class OrdersSseService implements OnModuleDestroy {
  private stream$ = new Subject<CustomerEvent>();
  private heartbeat$ = interval(15000).pipe(
    map(() => ({ type: 'ping' as const })),
  );

  onModuleDestroy() {
    this.stream$.complete();
  }

  /** stream สำหรับ @Sse() */
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

  /** ส่งออเดอร์ปัจจุบันให้จอฝั่งลูกค้า (หรือส่ง null เพื่อเคลียร์) */
  emitOrder(orderOrNull: any | null) {
    const lean = orderOrNull?.toObject ? orderOrNull.toObject() : orderOrNull;
    this.stream$.next({ type: 'order', payload: lean ?? null });
  }

  /** ส่งออเดอร์ แล้วตั้งเวลาเคลียร์อัตโนมัติ (เช่น เมื่อจ่ายเสร็จ) */
  emitOrderAndAutoClear(order: any, ms = 7000) {
    this.emitOrder(order);
    setTimeout(() => this.emitOrder(null), ms);
  }
}
