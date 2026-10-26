// Простейший анти-спам для оформления заказов.
// ВАЖНО: в backend нет штатного rate-limit; это ad-hoc защита в памяти воркера
// (best-effort, сбрасывается при рестарте, не делится между инстансами).
// Достаточна как первый барьер от массовых ботов; серьёзная защита — за периметром (CDN/WAF).
//
// Проверка и запись разделены намеренно: PRICE_CHANGED (честное подтверждение
// изменившейся цены) НЕ расходует лимит — иначе покупатель, дважды
// подтверждающий актуальную цену, блокировал бы себя. Счётчик увеличивается
// только когда заказ реально записан (recordOrderHit).

const WINDOW_MS = 10 * 60 * 1000; // 10 минут
const MAX_PER_WINDOW = 5; // 5 заказов за 10 минут на один ключ

const hits = new Map<string, number[]>();

function prune(now: number): void {
  for (const [k, v] of hits) {
    const alive = v.filter((t) => now - t < WINDOW_MS);
    if (alive.length === 0) hits.delete(k);
    else hits.set(k, alive);
  }
}

/** Проверка без записи: есть ли место в окне для ещё одного заказа. */
export function peekOrderRateLimit(key: string, now = Date.now()): boolean {
  const arr = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= MAX_PER_WINDOW) {
    hits.set(key, arr);
    return false;
  }
  return true;
}

/** Учесть фактически записанный заказ (вызывать только после успешного INSERT). */
export function recordOrderHit(key: string, now = Date.now()): void {
  const arr = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  hits.set(key, arr);
  // Не даём карте расти бесконечно.
  if (hits.size > 10_000) prune(now);
}

/** Совместимость: проверить и сразу учесть (для мест, где запись гарантирована). */
export function checkOrderRateLimit(key: string, now = Date.now()): boolean {
  if (!peekOrderRateLimit(key, now)) return false;
  recordOrderHit(key, now);
  return true;
}

export function resetOrderRateLimit() {
  hits.clear();
}
