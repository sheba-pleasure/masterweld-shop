import { canonicalPayload, type Submission } from "./submission";

const DATABASE = "mw-checkout-attempts";
const STORE = "attempts";
interface Reservation {
  fingerprint: string;
  requestId: string;
}
export class CheckoutCoordinationError extends Error {}

export async function attemptFingerprint(attempt: Submission): Promise<string> {
  // Match the existing server fingerprint exactly, including row order.
  const canonical = canonicalPayload(attempt);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: "fingerprint" });
    };
    request.onerror = () => {
      settled = true;
      reject(new CheckoutCoordinationError("STORAGE_UNAVAILABLE"));
    };
    request.onblocked = () => {
      settled = true;
      reject(new CheckoutCoordinationError("STORAGE_BLOCKED"));
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

async function transaction<T>(
  fingerprint: string,
  update: (previous: Reservation | undefined, store: IDBObjectStore) => T,
): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = database.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      let result: T;
      let failure: unknown;
      const read = store.get(fingerprint);
      read.onsuccess = () => {
        try {
          const value: unknown = read.result;
          if (
            value !== undefined &&
            (typeof value !== "object" ||
              value === null ||
              !("fingerprint" in value) ||
              value.fingerprint !== fingerprint ||
              !("requestId" in value) ||
              typeof value.requestId !== "string" ||
              !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                value.requestId,
              ))
          )
            throw new CheckoutCoordinationError("STORAGE_INVALID");
          result = update(value as Reservation | undefined, store);
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure ?? new CheckoutCoordinationError("STORAGE_UNAVAILABLE"));
      tx.onerror = () => {
        failure ??= new CheckoutCoordinationError("STORAGE_UNAVAILABLE");
      };
    });
  } finally {
    database.close();
  }
}

/** One durable ID per identical payload; read/write transactions serialize tabs. */
export async function reserveAttempt(
  candidate: Submission,
  options: { resume?: boolean; repeatOf?: string } = {},
): Promise<{ attempt: Submission; reused: boolean }> {
  const fingerprint = await attemptFingerprint(candidate);
  return transaction(fingerprint, (previous, store) => {
    if (options.resume && previous && previous.requestId !== candidate.requestId)
      throw new CheckoutCoordinationError("ATTEMPT_CONFLICT");
    if (options.repeatOf && !previous) throw new CheckoutCoordinationError("REPEAT_NOT_FOUND");
    // A second confirmation racing the first reuses the ID already rotated by it.
    if (previous && previous.requestId !== options.repeatOf)
      return { attempt: { ...candidate, requestId: previous.requestId }, reused: true };
    store.put({ fingerprint, requestId: candidate.requestId } satisfies Reservation);
    return { attempt: candidate, reused: false };
  });
}

/** Only a definitive rejection permits a fresh ID without another-order confirmation. */
export async function forgetRejectedAttempt(attempt: Submission): Promise<void> {
  const fingerprint = await attemptFingerprint(attempt);
  await transaction(fingerprint, (previous, store) => {
    if (previous?.requestId === attempt.requestId) store.delete(fingerprint);
  });
}
