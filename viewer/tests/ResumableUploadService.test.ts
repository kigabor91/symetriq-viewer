import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import {
    calculatePartRange,
    fileMatchesStoredUpload,
    listStoredResumableUploads,
    removeStoredResumableUpload,
    ResumableUploadClient,
    ResumableUploadError,
    type ResumableUploadSnapshot,
    type StoredResumableUpload,
    type UploadSessionDto,
} from "../src/services/ResumableUploadService.ts";

class MemoryStorage {
    private readonly values = new Map<string, string>();
    getItem(key: string): string | null { return this.values.get(key) ?? null; }
    setItem(key: string, value: string): void { this.values.set(key, value); }
    removeItem(key: string): void { this.values.delete(key); }
}

function json(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

function session(overrides: Partial<UploadSessionDto> = {}): UploadSessionDto {
    return {
        uploadId: "upload-1",
        projectId: "project-1",
        filename: "scan.e57",
        mimeType: "application/octet-stream",
        fileKind: "structured-e57",
        totalBytes: 10,
        receivedBytes: 0,
        chunkSize: 4,
        totalParts: 3,
        uploadedParts: [],
        status: "created",
        ...overrides,
    };
}

const immediateDelay = async () => undefined;

test("part slicing honors server-sized chunks, a partial final chunk and >2 GiB arithmetic", () => {
    assert.deepEqual(calculatePartRange(3, 4, 0), { start: 0, end: 3, size: 3 });
    assert.deepEqual(calculatePartRange(10, 4, 0), { start: 0, end: 4, size: 4 });
    assert.deepEqual(calculatePartRange(10, 4, 2), { start: 8, end: 10, size: 2 });
    assert.deepEqual(
        calculatePartRange(4_400_000_001, 2_200_000_000, 2),
        { start: 4_400_000_000, end: 4_400_000_001, size: 1 },
    );
});

test("invokes fetch with the browser global receiver", async () => {
    const file = new File(["x"], "scan.e57", { lastModified: 123 });
    const fetchMock = async function (
        this: unknown,
        input: RequestInfo | URL,
        init?: RequestInit,
    ): Promise<Response> {
        assert.equal(this, globalThis);
        const url = String(input);
        if (url.endsWith("/api/projects/project-1/uploads")) {
            return json(session({ totalBytes: 1, chunkSize: 1, totalParts: 1 }));
        }
        if (url.endsWith("/parts/0")) return json({ receivedBytes: 1 }, 201);
        if (url.endsWith("/api/uploads/upload-1") && init?.method !== "POST") {
            return json(session({
                status: "uploading",
                totalBytes: 1,
                receivedBytes: 1,
                chunkSize: 1,
                totalParts: 1,
                uploadedParts: [0],
            }));
        }
        if (url.endsWith("/complete") && init?.method === "POST") {
            return json(session({
                status: "complete",
                totalBytes: 1,
                receivedBytes: 1,
                chunkSize: 1,
                totalParts: 1,
                uploadedParts: [0],
            }));
        }
        throw new Error(`Unexpected request ${url}`);
    } as typeof fetch;

    const result = await new ResumableUploadClient({
        fetch: fetchMock,
        storage: new MemoryStorage(),
        retryDelaysMs: [],
        delay: immediateDelay,
        idFactory: () => "receiver-test",
    }).start("project-1", file, "structured-e57");

    assert.equal(result.status, "complete");
});

test("uploads raw Blob slices with concurrency two, then finalizes and polls to complete", async () => {
    const file = new File([Buffer.from("abcdefghij")], "scan.e57", { lastModified: 123 });
    const storage = new MemoryStorage();
    const partSizes: number[] = [];
    let active = 0;
    let maximumActive = 0;
    let receivedBytes = 0;
    const uploaded = new Set<number>();
    let finalPolls = 0;
    const snapshots: ResumableUploadSnapshot[] = [];
    const fetchMock: typeof fetch = async (input, init) => {
        const url = String(input);
        if (url.endsWith("/api/projects/project-1/uploads")) return json(session());
        if (/\/parts\/\d+$/.test(url)) {
            assert.equal(new Headers(init?.headers).get("Content-Type"), "application/octet-stream");
            assert.equal(new Headers(init?.headers).has("Content-Length"), false);
            const body = init?.body;
            assert.ok(body instanceof Blob);
            const partNumber = Number(url.split("/").at(-1));
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            await delay(5);
            partSizes[partNumber] = body.size;
            uploaded.add(partNumber);
            receivedBytes += body.size;
            active -= 1;
            return json({ receivedBytes });
        }
        if (url.endsWith("/complete") && init?.method === "POST") {
            return json(session({ status: "finalizing", receivedBytes: 10, uploadedParts: [0, 1, 2] }), 202);
        }
        if (url.endsWith("/api/uploads/upload-1")) {
            if (uploaded.size < 3) return json(session({ status: "uploading", receivedBytes, uploadedParts: [...uploaded] }));
            finalPolls += 1;
            return json(session({
                status: finalPolls >= 2 ? "complete" : "uploading",
                receivedBytes: 10,
                uploadedParts: [0, 1, 2],
                ...(finalPolls >= 2 ? { finalSha256: "a".repeat(64), finalBytes: 10 } : {}),
            }));
        }
        throw new Error(`Unexpected request ${url}`);
    };
    const client = new ResumableUploadClient({
        fetch: fetchMock,
        storage,
        delay: immediateDelay,
        pollIntervalMs: 0,
        idFactory: () => "idempotency-1",
        onChange: (snapshot) => snapshots.push(snapshot),
    });
    const result = await client.start("project-1", file, "structured-e57");
    assert.equal(result.status, "complete");
    assert.deepEqual(partSizes, [4, 4, 2]);
    assert.equal(maximumActive, 2);
    assert.ok(snapshots.some((snapshot) => snapshot.state === "finalizing"));
    assert.equal(snapshots.at(-1)?.percent, 100);
    assert.deepEqual(listStoredResumableUploads(storage), []);
});

test("session creation retries with the same idempotency key", async () => {
    const file = new File(["data"], "scan.e57", { lastModified: 1 });
    const keys: string[] = [];
    let createAttempts = 0;
    let uploaded = false;
    const fetchMock: typeof fetch = async (input, init) => {
        const url = String(input);
        if (url.includes("/projects/") && init?.method === "POST") {
            keys.push(new Headers(init.headers).get("Idempotency-Key") ?? "");
            createAttempts += 1;
            if (createAttempts === 1) throw new TypeError("response lost");
            return json(session({ totalBytes: 4, totalParts: 1, chunkSize: 8 }));
        }
        if (url.endsWith("/parts/0")) {
            uploaded = true;
            return json({ receivedBytes: 4 });
        }
        if (url.endsWith("/complete")) return json(session({ status: "complete", totalBytes: 4, receivedBytes: 4, totalParts: 1, uploadedParts: [0] }));
        if (url.endsWith("/api/uploads/upload-1")) return json(session({
            status: "uploading", totalBytes: 4, receivedBytes: uploaded ? 4 : 0,
            totalParts: 1, chunkSize: 8, uploadedParts: uploaded ? [0] : [],
        }));
        throw new Error(`Unexpected request ${url}`);
    };
    await new ResumableUploadClient({
        fetch: fetchMock,
        storage: new MemoryStorage(),
        retryDelaysMs: [0],
        delay: immediateDelay,
        idFactory: () => "stable-key",
    }).start("project-1", file, "structured-e57");
    assert.deepEqual(keys, ["stable-key", "stable-key"]);
});

test("a backend without the resumable route reports an actionable API error", async () => {
    let snapshot: ResumableUploadSnapshot | undefined;
    const client = new ResumableUploadClient({
        fetch: async () => new Response("Cannot POST", { status: 404, headers: { "Content-Type": "text/html" } }),
        storage: new MemoryStorage(),
        retryDelaysMs: [],
        delay: immediateDelay,
        onChange: (next) => { snapshot = next; },
    });
    await assert.rejects(
        client.start("project-1", new File(["data"], "scan.e57"), "structured-e57"),
        (error: unknown) => error instanceof ResumableUploadError && error.code === "UPLOAD_API_UNAVAILABLE",
    );
    assert.equal(snapshot?.state, "failed");
    assert.match(snapshot?.message ?? "", /update and restart/i);
});

test("resume trusts uploadedParts and sends only the missing chunk", async () => {
    const file = new File([Buffer.from("abcdefghijklmnop")], "scan.e57", { lastModified: 5 });
    const stored: StoredResumableUpload = {
        uploadId: "upload-1", projectId: "project-1", filename: "scan.e57", size: 16,
        lastModified: 5, fileKind: "structured-e57", idempotencyKey: "key", createdAt: new Date().toISOString(),
    };
    const uploadedParts: number[] = [];
    let getCount = 0;
    const fetchMock: typeof fetch = async (input, init) => {
        const url = String(input);
        if (url.endsWith("/parts/2")) {
            uploadedParts.push(2);
            return json({ receivedBytes: 16 });
        }
        if (/\/parts\//.test(url)) throw new Error(`Unexpected part ${url}`);
        if (url.endsWith("/complete")) return json(session({ status: "complete", totalBytes: 16, receivedBytes: 16, totalParts: 4, uploadedParts: [0, 1, 2, 3] }));
        if (url.endsWith("/api/uploads/upload-1")) {
            getCount += 1;
            return json(session({
                totalBytes: 16, receivedBytes: getCount > 1 ? 16 : 12, totalParts: 4,
                uploadedParts: getCount > 1 ? [0, 1, 2, 3] : [0, 1, 3], status: "uploading",
            }));
        }
        throw new Error(`Unexpected request ${url} ${init?.method}`);
    };
    const result = await new ResumableUploadClient({
        fetch: fetchMock, storage: new MemoryStorage(), delay: immediateDelay,
    }).resume(stored, file);
    assert.equal(result.status, "complete");
    assert.deepEqual(uploadedParts, [2]);
});

test("transient part failure is retried, while PART_CONFLICT stops deterministically", async () => {
    const file = new File(["data"], "scan.e57", { lastModified: 1 });
    let attempts = 0;
    let transientUploaded = false;
    const transientFetch: typeof fetch = async (input, init) => {
        const url = String(input);
        if (url.includes("/projects/") && init?.method === "POST") return json(session({ totalBytes: 4, totalParts: 1 }));
        if (url.endsWith("/parts/0")) {
            attempts += 1;
            if (attempts === 1) return json({ error: { code: "TEMP", message: "temporary", retryable: true } }, 503);
            transientUploaded = true;
            return json({ receivedBytes: 4 });
        }
        if (url.endsWith("/complete")) return json(session({ status: "complete", totalBytes: 4, receivedBytes: 4, totalParts: 1, uploadedParts: [0] }));
        return json(session({
            status: "uploading", totalBytes: 4, totalParts: 1,
            receivedBytes: transientUploaded ? 4 : 0,
            uploadedParts: transientUploaded ? [0] : [],
        }));
    };
    await new ResumableUploadClient({
        fetch: transientFetch, storage: new MemoryStorage(), retryDelaysMs: [0], delay: immediateDelay,
    }).start("project-1", file, "structured-e57");
    assert.equal(attempts, 2);

    let conflictAttempts = 0;
    let lastSnapshot: ResumableUploadSnapshot | undefined;
    const conflictFetch: typeof fetch = async (input, init) => {
        const url = String(input);
        if (url.includes("/projects/") && init?.method === "POST") return json(session({ totalBytes: 4, totalParts: 1 }));
        if (url.endsWith("/parts/0")) {
            conflictAttempts += 1;
            return json({ error: { code: "PART_CONFLICT", message: "different", retryable: false } }, 409);
        }
        return json(session({ status: "uploading", totalBytes: 4, totalParts: 1 }));
    };
    await assert.rejects(
        new ResumableUploadClient({
            fetch: conflictFetch, storage: new MemoryStorage(), retryDelaysMs: [0, 0], delay: immediateDelay,
            onChange: (snapshot) => { lastSnapshot = snapshot; },
        }).start("project-1", file, "structured-e57"),
        (error: unknown) => error instanceof ResumableUploadError && error.code === "PART_CONFLICT",
    );
    assert.equal(conflictAttempts, 1);
    assert.equal(lastSnapshot?.state, "failed");
    assert.match(lastSnapshot?.message ?? "", /differs/);
});

test("a lost successful part response safely resends the same Blob in the same session", async () => {
    const file = new File(["data"], "scan.e57", { lastModified: 2 });
    let putAttempts = 0;
    let committed = false;
    const fetchMock: typeof fetch = async (input, init) => {
        const url = String(input);
        if (url.includes("/projects/") && init?.method === "POST") {
            return json(session({ totalBytes: 4, totalParts: 1 }));
        }
        if (url.endsWith("/parts/0")) {
            putAttempts += 1;
            if (!committed) {
                committed = true;
                throw new TypeError("response was lost after commit");
            }
            return json({ receivedBytes: 4, alreadyPresent: true });
        }
        if (url.endsWith("/complete")) {
            return json(session({ status: "complete", totalBytes: 4, receivedBytes: 4, totalParts: 1, uploadedParts: [0] }));
        }
        return json(session({
            status: "uploading", totalBytes: 4, totalParts: 1,
            receivedBytes: committed ? 4 : 0, uploadedParts: committed ? [0] : [],
        }));
    };
    const result = await new ResumableUploadClient({
        fetch: fetchMock, storage: new MemoryStorage(), retryDelaysMs: [0], delay: immediateDelay,
    }).start("project-1", file, "structured-e57");
    assert.equal(result.status, "complete");
    assert.equal(putAttempts, 2);
});

test("a recoverable same-page failure can retry using the retained File and server state", async () => {
    const file = new File(["data"], "scan.e57", { lastModified: 4 });
    let putAttempts = 0;
    let uploaded = false;
    const fetchMock: typeof fetch = async (input, init) => {
        const url = String(input);
        if (url.includes("/projects/") && init?.method === "POST") {
            return json(session({ totalBytes: 4, totalParts: 1 }));
        }
        if (url.endsWith("/parts/0")) {
            putAttempts += 1;
            if (putAttempts === 1) throw new TypeError("offline");
            uploaded = true;
            return json({ receivedBytes: 4 });
        }
        if (url.endsWith("/complete")) {
            return json(session({ status: "complete", totalBytes: 4, receivedBytes: 4, totalParts: 1, uploadedParts: [0] }));
        }
        return json(session({
            status: "uploading", totalBytes: 4, totalParts: 1,
            receivedBytes: uploaded ? 4 : 0, uploadedParts: uploaded ? [0] : [],
        }));
    };
    const client = new ResumableUploadClient({
        fetch: fetchMock, storage: new MemoryStorage(), retryDelaysMs: [], delay: immediateDelay,
    });
    await assert.rejects(client.start("project-1", file, "structured-e57"));
    const completed = await client.retry();
    assert.equal(completed.status, "complete");
    assert.equal(putAttempts, 2);
});

test("unfinished metadata survives reload and validates the reselected file", async () => {
    const storage = new MemoryStorage();
    const entry: StoredResumableUpload = {
        uploadId: "upload-1", projectId: "project-1", filename: "scan.e57", size: 4,
        lastModified: 10, fileKind: "structured-e57", idempotencyKey: "key", createdAt: "2026-09-22T10:00:00Z",
    };
    storage.setItem("symetriq.resumable-uploads.v1", JSON.stringify([entry]));
    assert.deepEqual(listStoredResumableUploads(storage), [entry]);
    assert.equal(fileMatchesStoredUpload(new File(["data"], "scan.e57", { lastModified: 10 }), entry), true);
    assert.equal(fileMatchesStoredUpload(new File(["DATA"], "other.e57", { lastModified: 10 }), entry), false);
    removeStoredResumableUpload("upload-1", storage);
    assert.deepEqual(listStoredResumableUploads(storage), []);
});

test("a lost create response persists its idempotency key and recovers after reload", async () => {
    const storage = new MemoryStorage();
    const file = new File(["data"], "scan.e57", { lastModified: 11 });
    await assert.rejects(new ResumableUploadClient({
        fetch: async () => { throw new TypeError("offline after server create"); },
        storage,
        retryDelaysMs: [],
        delay: immediateDelay,
        idFactory: () => "persisted-key",
    }).start("project-1", file, "structured-e57"));
    const [stored] = listStoredResumableUploads(storage);
    assert.equal(stored?.uploadId, undefined);
    assert.equal(stored?.idempotencyKey, "persisted-key");

    let createKey = "";
    let uploaded = false;
    const recoveredFetch: typeof fetch = async (input, init) => {
        const url = String(input);
        if (url.includes("/projects/") && init?.method === "POST") {
            createKey = new Headers(init.headers).get("Idempotency-Key") ?? "";
            return json(session({ totalBytes: 4, totalParts: 1 }));
        }
        if (url.endsWith("/parts/0")) {
            uploaded = true;
            return json({ receivedBytes: 4 });
        }
        if (url.endsWith("/complete")) {
            return json(session({ status: "complete", totalBytes: 4, receivedBytes: 4, totalParts: 1, uploadedParts: [0] }));
        }
        return json(session({
            status: "uploading", totalBytes: 4, totalParts: 1,
            receivedBytes: uploaded ? 4 : 0, uploadedParts: uploaded ? [0] : [],
        }));
    };
    const result = await new ResumableUploadClient({
        fetch: recoveredFetch, storage, delay: immediateDelay,
    }).resume(stored!, file);
    assert.equal(createKey, "persisted-key");
    assert.equal(result.status, "complete");
    assert.deepEqual(listStoredResumableUploads(storage), []);
});

test("explicit cancel aborts active part requests, calls DELETE and clears local state", async () => {
    const storage = new MemoryStorage();
    let deleteCalled = false;
    let partStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { partStarted = resolve; });
    const fetchMock: typeof fetch = async (input, init) => {
        const url = String(input);
        if (url.includes("/projects/") && init?.method === "POST") return json(session({ totalBytes: 4, totalParts: 1 }));
        if (url.endsWith("/api/uploads/upload-1") && init?.method === "DELETE") {
            deleteCalled = true;
            return json(session({ status: "cancelled", totalBytes: 4, totalParts: 1 }));
        }
        if (url.endsWith("/parts/0")) {
            partStarted?.();
            return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
            });
        }
        return json(session({ status: "uploading", totalBytes: 4, totalParts: 1 }));
    };
    const client = new ResumableUploadClient({ fetch: fetchMock, storage, retryDelaysMs: [], delay: immediateDelay });
    const upload = client.start("project-1", new File(["data"], "scan.e57"), "structured-e57");
    await started;
    await client.cancel();
    await assert.rejects(upload);
    assert.equal(deleteCalled, true);
    assert.deepEqual(listStoredResumableUploads(storage), []);
});

test("backend failed, cancelled and expired states map to terminal client states", async () => {
    const file = new File(["data"], "scan.e57", { lastModified: 3 });
    for (const backendStatus of ["failed", "cancelled", "expired"] as const) {
        const storage = new MemoryStorage();
        const stored: StoredResumableUpload = {
            uploadId: "upload-1", projectId: "project-1", filename: "scan.e57", size: 4,
            lastModified: 3, fileKind: "structured-e57", idempotencyKey: "key", createdAt: new Date().toISOString(),
        };
        storage.setItem("symetriq.resumable-uploads.v1", JSON.stringify([stored]));
        let finalState: ResumableUploadSnapshot["state"] | undefined;
        const fetchMock: typeof fetch = async () => json(session({
            status: backendStatus,
            totalBytes: 4,
            totalParts: 1,
            error: backendStatus === "failed"
                ? { code: "FINAL_HASH_MISMATCH", message: "bad hash", retryable: false }
                : undefined,
        }));
        await assert.rejects(new ResumableUploadClient({
            fetch: fetchMock,
            storage,
            delay: immediateDelay,
            onChange: (snapshot) => { finalState = snapshot.state; },
        }).resume(stored, file));
        assert.equal(finalState, backendStatus);
        assert.equal(listStoredResumableUploads(storage).length, backendStatus === "failed" ? 1 : 0);
    }
});
