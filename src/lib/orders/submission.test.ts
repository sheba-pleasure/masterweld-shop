import { describe, expect, it, vi } from "vitest";
import { submitOrder, AttemptConflict, type SubmissionStore } from "./submit.server";
import {
  canonicalPayload,
  loadAttempt,
  saveAttempt,
  submissionSchema,
  ATTEMPT_STORAGE_KEY,
  type Submission,
} from "./submission";
const data: Submission = {
  requestId: "11111111-1111-4111-8111-111111111111",
  name: "Учебный покупатель",
  phone: "+79990000000",
  comment: null,
  items: [{ product_id: "22222222-2222-4222-8222-222222222222", qty: 1 }],
  expected: {
    total: 900,
    items: [{ product_id: "22222222-2222-4222-8222-222222222222", unit_price: 900 }],
  },
};
const receipt = { ok: true, number: "#12345678", total: 900, hasBackorder: false };
function fixture() {
  const store: SubmissionStore = {
    lookup: vi.fn().mockResolvedValue(null),
    products: vi.fn().mockResolvedValue([
      {
        id: data.items[0]!.product_id,
        slug: "test",
        title: "Тест",
        price: 900,
        status: "published",
        in_stock: true,
      },
    ]),
    commit: vi.fn().mockResolvedValue(receipt),
  };
  const limit = { allowed: vi.fn().mockReturnValue(true), record: vi.fn() };
  return { store, limit };
}
describe("durable checkout boundary", () => {
  it("requires a request ID; old clients fail closed", () => {
    expect(submissionSchema.safeParse({ ...data, requestId: undefined }).success).toBe(false);
  });
  it("returns receipt before catalog changes or exhausted rate limit", async () => {
    const { store, limit } = fixture();
    vi.mocked(store.lookup).mockResolvedValue(receipt);
    limit.allowed.mockReturnValue(false);
    expect(await submitOrder(data, store, limit)).toEqual(receipt);
    expect(store.products).not.toHaveBeenCalled();
    expect(store.commit).not.toHaveBeenCalled();
  });
  it("lost response is uncertain; retry returns the saved order", async () => {
    const { store, limit } = fixture();
    vi.mocked(store.commit).mockImplementation(async () => {
      vi.mocked(store.lookup).mockResolvedValue(receipt);
      throw new Error("lost after commit");
    });
    expect(await submitOrder(data, store, limit)).toMatchObject({ ok: false, code: "UNKNOWN" });
    expect(await submitOrder(data, store, limit)).toEqual(receipt);
    expect(store.commit).toHaveBeenCalledTimes(1);
  });
  it("cannot treat a lookup failure as permission for a new write", async () => {
    const { store, limit } = fixture();
    vi.mocked(store.lookup).mockRejectedValue(new Error("timeout"));
    expect(await submitOrder(data, store, limit)).toMatchObject({ code: "UNKNOWN" });
    expect(store.commit).not.toHaveBeenCalled();
  });
  it("different payload on one ID never becomes a fresh order", async () => {
    const { store, limit } = fixture();
    vi.mocked(store.lookup).mockRejectedValue(new AttemptConflict());
    expect(await submitOrder(data, store, limit)).toMatchObject({ code: "ATTEMPT_CONFLICT" });
    expect(store.products).not.toHaveBeenCalled();
  });
  it("persists price rejection before permitting a new confirmed attempt", async () => {
    const { store, limit } = fixture();
    vi.mocked(store.commit).mockImplementation(async (_a, _h, _o, rejection) => rejection!);
    expect(await submitOrder({ ...data, expected: { total: 1 } }, store, limit)).toMatchObject({
      code: "PRICE_CHANGED",
      total: 900,
    });
    expect(store.commit).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/^[a-f0-9]{64}$/),
      null,
      expect.objectContaining({ code: "PRICE_CHANGED" }),
    );
  });
  it("a competing accepted receipt wins over a later rejection", async () => {
    const { store, limit } = fixture();
    // commit serializes competing results; DB integration checks the actual lock.
    expect(await submitOrder({ ...data, expected: { total: 1 } }, store, limit)).toEqual(receipt);
  });
  it("failed rejection acknowledgement stays uncertain", async () => {
    const { store, limit } = fixture();
    limit.allowed.mockReturnValue(false);
    vi.mocked(store.commit).mockRejectedValue(new Error("lost rejection"));
    expect(await submitOrder(data, store, limit)).toMatchObject({ code: "UNKNOWN" });
  });
  it("hash binds contact, contents and accepted price, independent of request ID", () => {
    expect(canonicalPayload(data)).toBe(
      canonicalPayload({ ...data, requestId: crypto.randomUUID() } as Submission),
    );
    for (const changed of [
      { ...data, name: "Другое имя" },
      { ...data, expected: { total: 901 } },
      { ...data, items: [{ ...data.items[0]!, qty: 2 }] },
    ]) {
      expect(canonicalPayload(changed)).not.toBe(canonicalPayload(data));
    }
  });
});
describe("reload recovery", () => {
  it("restores the same ID and immutable payload", () => {
    const mem = new Map<string, string>();
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => {
        mem.set(k, v);
      },
    };
    saveAttempt(storage, data);
    expect(loadAttempt(storage)).toEqual(data);
  });
  it("blocked storage and corrupted attempts fail closed", () => {
    expect(() => saveAttempt({ getItem: () => null, setItem: () => {} }, data)).toThrow();
    expect(() =>
      loadAttempt({ getItem: (k) => (k === ATTEMPT_STORAGE_KEY ? "{}" : null) }),
    ).toThrow();
  });
});
