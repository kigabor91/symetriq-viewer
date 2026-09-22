export type ResumableFileKind = "structured-e57" | "ifc" | "point-cloud";

export type ResumableUploadState =
    | "idle"
    | "creating-session"
    | "uploading"
    | "retrying"
    | "recoverable"
    | "finalizing"
    | "complete"
    | "failed"
    | "cancelled"
    | "expired";

export interface UploadSessionDto {
    uploadId: string;
    projectId: string;
    filename: string;
    mimeType: string;
    fileKind: ResumableFileKind;
    totalBytes: number;
    receivedBytes: number;
    chunkSize: number;
    totalParts: number;
    uploadedParts: number[];
    status: "created" | "uploading" | "finalizing" | "complete" | "failed" | "cancelled" | "expired";
    finalBytes?: number;
    finalSha256?: string;
    error?: { code: string; message: string; retryable: boolean };
}

export interface StoredResumableUpload {
    uploadId?: string;
    projectId: string;
    filename: string;
    size: number;
    lastModified: number;
    fileKind: ResumableFileKind;
    idempotencyKey: string;
    createdAt: string;
}

export interface ResumableUploadSnapshot {
    uploadId?: string;
    filename: string;
    totalBytes: number;
    receivedBytes: number;
    completedParts: number;
    totalParts: number;
    percent: number;
    state: ResumableUploadState;
    message?: string;
    finalSha256?: string;
}

interface StorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

interface ResumableUploadClientOptions {
    fetch?: typeof fetch;
    storage?: StorageLike;
    concurrency?: number;
    retryDelaysMs?: number[];
    pollIntervalMs?: number;
    delay?: (milliseconds: number) => Promise<void>;
    idFactory?: () => string;
    onChange?: (snapshot: ResumableUploadSnapshot) => void;
}

interface BackendErrorBody {
    error?: string | { code?: string; message?: string; retryable?: boolean };
}

const STORAGE_KEY = "symetriq.resumable-uploads.v1";
export const DEFAULT_RESUMABLE_UPLOAD_CONCURRENCY = 2;
export const VIEWER_RESUMABLE_UPLOAD_MAX_BYTES = 50 * 1024 ** 3;

export class ResumableUploadError extends Error {
    readonly code: string;
    readonly status: number;
    readonly retryable: boolean;

    constructor(code: string, message: string, status = 0, retryable = false) {
        super(message);
        this.name = "ResumableUploadError";
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

export function calculatePartRange(
    fileSize: number,
    chunkSize: number,
    partNumber: number,
): { start: number; end: number; size: number } {
    if (!Number.isSafeInteger(fileSize) || fileSize <= 0
        || !Number.isSafeInteger(chunkSize) || chunkSize <= 0
        || !Number.isSafeInteger(partNumber) || partNumber < 0) {
        throw new Error("Invalid upload part range.");
    }
    const start = partNumber * chunkSize;
    const end = Math.min(start + chunkSize, fileSize);
    if (!Number.isSafeInteger(start) || start >= fileSize || end <= start) {
        throw new Error("Upload part number is outside the file range.");
    }
    return { start, end, size: end - start };
}

export function inferResumableFileKind(filename: string): ResumableFileKind | undefined {
    const extension = filename.slice(filename.lastIndexOf(".")).toLowerCase();
    if (extension === ".e57") return "structured-e57";
    if (extension === ".ifc") return "ifc";
    if (extension === ".las" || extension === ".laz") return "point-cloud";
    return undefined;
}

export function fileMatchesStoredUpload(file: File, stored: StoredResumableUpload): boolean {
    return file.name === stored.filename
        && file.size === stored.size
        && (stored.lastModified === 0 || file.lastModified === stored.lastModified);
}

export function listStoredResumableUploads(storage: StorageLike = window.localStorage): StoredResumableUpload[] {
    try {
        const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? "[]") as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((value): value is StoredResumableUpload => {
            if (typeof value !== "object" || value === null) return false;
            const candidate = value as Partial<StoredResumableUpload>;
            return (candidate.uploadId === undefined || typeof candidate.uploadId === "string")
                && typeof candidate.projectId === "string"
                && typeof candidate.filename === "string"
                && Number.isSafeInteger(candidate.size)
                && typeof candidate.lastModified === "number"
                && typeof candidate.idempotencyKey === "string"
                && typeof candidate.createdAt === "string"
                && ["structured-e57", "ifc", "point-cloud"].includes(candidate.fileKind ?? "");
        });
    } catch {
        return [];
    }
}

export function removeStoredResumableUpload(identifier: string, storage: StorageLike = window.localStorage): void {
    const remaining = listStoredResumableUploads(storage)
        .filter((entry) => entry.uploadId !== identifier && entry.idempotencyKey !== identifier);
    storage.setItem(STORAGE_KEY, JSON.stringify(remaining));
}

function storeResumableUpload(entry: StoredResumableUpload, storage: StorageLike): void {
    const entries = listStoredResumableUploads(storage).filter((candidate) => (
        candidate.idempotencyKey !== entry.idempotencyKey
        && (entry.uploadId === undefined || candidate.uploadId !== entry.uploadId)
    ));
    storage.setItem(STORAGE_KEY, JSON.stringify([...entries, entry]));
}

function defaultDelay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function mapBackendState(status: UploadSessionDto["status"]): ResumableUploadState {
    if (status === "created" || status === "uploading") return "uploading";
    return status;
}

export class ResumableUploadClient {
    private readonly fetchImplementation: typeof fetch;
    private readonly storage: StorageLike;
    private readonly concurrency: number;
    private readonly retryDelaysMs: number[];
    private readonly pollIntervalMs: number;
    private readonly delay: (milliseconds: number) => Promise<void>;
    private readonly idFactory: () => string;
    private readonly onChange: (snapshot: ResumableUploadSnapshot) => void;
    private readonly activeControllers = new Set<AbortController>();
    private cancelled = false;
    private session?: UploadSessionDto;
    private stored?: StoredResumableUpload;
    private file?: File;
    private state: ResumableUploadState = "idle";

    constructor(options: ResumableUploadClientOptions = {}) {
        this.fetchImplementation = options.fetch ?? fetch;
        this.storage = options.storage ?? window.localStorage;
        this.concurrency = options.concurrency ?? DEFAULT_RESUMABLE_UPLOAD_CONCURRENCY;
        this.retryDelaysMs = options.retryDelaysMs ?? [500, 1_500, 4_000];
        this.pollIntervalMs = options.pollIntervalMs ?? 1_500;
        this.delay = options.delay ?? defaultDelay;
        this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
        this.onChange = options.onChange ?? (() => undefined);
        if (!Number.isSafeInteger(this.concurrency) || this.concurrency <= 0) {
            throw new Error("Upload concurrency must be a positive integer.");
        }
    }

    async start(projectId: string, file: File, fileKind: ResumableFileKind): Promise<UploadSessionDto> {
        this.validateFile(file);
        this.cancelled = false;
        this.file = file;
        const idempotencyKey = this.idFactory();
        this.stored = {
            projectId,
            filename: file.name,
            size: file.size,
            lastModified: file.lastModified,
            fileKind,
            idempotencyKey,
            createdAt: new Date().toISOString(),
        };
        storeResumableUpload(this.stored, this.storage);
        this.publish("creating-session", undefined, file);
        let session: UploadSessionDto;
        try {
            session = await this.requestWithRetry<UploadSessionDto>(
                `/api/projects/${encodeURIComponent(projectId)}/uploads`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Idempotency-Key": idempotencyKey,
                    },
                    body: JSON.stringify({
                        filename: file.name,
                        mimeType: file.type || "application/octet-stream",
                        fileKind,
                        totalBytes: file.size,
                    }),
                },
            );
        } catch (error) {
            const normalized = this.normalizeError(error);
            this.publish(normalized.retryable || normalized.status === 0 ? "recoverable" : "failed", this.userMessage(normalized));
            throw normalized;
        }
        this.session = session;
        this.stored = {
            ...this.stored,
            uploadId: session.uploadId,
        };
        storeResumableUpload(this.stored, this.storage);
        return this.uploadAndFinalize();
    }

    async resume(stored: StoredResumableUpload, file: File): Promise<UploadSessionDto> {
        this.validateFile(file);
        if (!fileMatchesStoredUpload(file, stored)) {
            throw new ResumableUploadError(
                "FILE_RESELECTION_MISMATCH",
                "The selected file does not match the filename, size and modification time of this upload.",
                400,
            );
        }
        this.cancelled = false;
        this.file = file;
        this.stored = stored;
        if (stored.uploadId) {
            this.session = await this.getSession(stored.uploadId);
        } else {
            this.publish("creating-session", undefined, file);
            try {
                this.session = await this.requestWithRetry<UploadSessionDto>(
                    `/api/projects/${encodeURIComponent(stored.projectId)}/uploads`,
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "Idempotency-Key": stored.idempotencyKey,
                        },
                        body: JSON.stringify({
                            filename: file.name,
                            mimeType: file.type || "application/octet-stream",
                            fileKind: stored.fileKind,
                            totalBytes: file.size,
                        }),
                    },
                );
            } catch (error) {
                const normalized = this.normalizeError(error);
                this.publish(normalized.retryable || normalized.status === 0 ? "recoverable" : "failed", this.userMessage(normalized));
                throw normalized;
            }
            this.stored = { ...stored, uploadId: this.session.uploadId };
            storeResumableUpload(this.stored, this.storage);
        }
        return this.uploadAndFinalize(false);
    }

    async retry(): Promise<UploadSessionDto> {
        const file = this.requireFile();
        if (this.session) {
            this.cancelled = false;
            return this.uploadAndFinalize();
        }
        if (this.stored) return this.resume(this.stored, file);
        throw new ResumableUploadError("UPLOAD_NOT_INITIALIZED", "There is no upload to retry.", 400);
    }

    async cancel(): Promise<void> {
        this.cancelled = true;
        for (const controller of this.activeControllers) controller.abort();
        this.activeControllers.clear();
        const uploadId = this.session?.uploadId ?? this.stored?.uploadId;
        if (uploadId) {
            const response = await this.fetchImplementation(
                `/api/uploads/${encodeURIComponent(uploadId)}`,
                { method: "DELETE" },
            );
            if (!response.ok) throw await this.responseError(response, `/api/uploads/${encodeURIComponent(uploadId)}`);
            removeStoredResumableUpload(uploadId, this.storage);
        } else if (this.stored) {
            removeStoredResumableUpload(this.stored.idempotencyKey, this.storage);
        }
        this.publish("cancelled", "Upload cancelled.");
    }

    async discard(stored: StoredResumableUpload): Promise<void> {
        this.stored = stored;
        await this.cancel();
    }

    private async uploadAndFinalize(refreshSession = true): Promise<UploadSessionDto> {
        try {
            let session = refreshSession
                ? await this.getSession(this.requireSession().uploadId)
                : this.requireSession();
            this.session = session;
            this.persistOrClean(session);
            if (session.status === "finalizing") return this.pollFinalization();
            if (session.status === "complete") return this.finish(session);
            if (["failed", "cancelled", "expired"].includes(session.status)) return this.handleTerminal(session);

            const uploaded = new Set(session.uploadedParts);
            const missing = Array.from({ length: session.totalParts }, (_value, partNumber) => partNumber)
                .filter((partNumber) => !uploaded.has(partNumber));
            this.publish("uploading");
            let cursor = 0;
            let firstError: unknown;
            const workers = Array.from({ length: Math.min(this.concurrency, missing.length) }, async () => {
                while (!this.cancelled && firstError === undefined) {
                    const queueIndex = cursor;
                    cursor += 1;
                    if (queueIndex >= missing.length) return;
                    const partNumber = missing[queueIndex]!;
                    try {
                        const result = await this.uploadPart(partNumber);
                        uploaded.add(partNumber);
                        session = {
                            ...session,
                            receivedBytes: Math.max(session.receivedBytes, result.receivedBytes),
                            uploadedParts: [...uploaded].sort((left, right) => left - right),
                            status: "uploading",
                        };
                        this.session = session;
                        this.publish("uploading");
                    } catch (error) {
                        firstError = error;
                    }
                }
            });
            await Promise.allSettled(workers);
            if (this.cancelled) throw new ResumableUploadError("UPLOAD_CANCELLED", "Upload cancelled.", 409);
            if (firstError !== undefined) throw firstError;

            // Server state is authoritative, including the lost-response case.
            session = await this.getSession(session.uploadId);
            this.session = session;
            if (session.uploadedParts.length !== session.totalParts || session.receivedBytes !== session.totalBytes) {
                throw new ResumableUploadError("UPLOAD_INCOMPLETE", "The server has not confirmed every upload part.", 409, true);
            }
            const completing = await this.requestWithRetry<UploadSessionDto>(
                `/api/uploads/${encodeURIComponent(session.uploadId)}/complete`,
                { method: "POST" },
            );
            this.session = completing;
            if (completing.status === "complete") return this.finish(completing);
            this.publish("finalizing");
            return this.pollFinalization();
        } catch (error) {
            if (this.cancelled) {
                this.publish("cancelled", "Upload cancelled.");
                throw error;
            }
            const normalized = this.normalizeError(error);
            if (this.session && ["failed", "cancelled", "expired"].includes(this.session.status)) {
                throw normalized;
            }
            const recoverable = normalized.retryable || normalized.status === 0;
            this.publish(recoverable ? "recoverable" : "failed", this.userMessage(normalized));
            throw normalized;
        }
    }

    private async uploadPart(partNumber: number): Promise<{ receivedBytes: number }> {
        const session = this.requireSession();
        const file = this.requireFile();
        const range = calculatePartRange(file.size, session.chunkSize, partNumber);
        const body = file.slice(range.start, range.end);
        return this.requestWithRetry<{ receivedBytes: number }>(
            `/api/uploads/${encodeURIComponent(session.uploadId)}/parts/${partNumber}`,
            { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body },
        );
    }

    private async pollFinalization(): Promise<UploadSessionDto> {
        const uploadId = this.requireSession().uploadId;
        this.publish("finalizing");
        while (!this.cancelled) {
            await this.delay(this.pollIntervalMs);
            const session = await this.getSession(uploadId);
            this.session = session;
            if (session.status === "finalizing") {
                this.publish("finalizing");
                continue;
            }
            if (session.status === "complete") return this.finish(session);
            return this.handleTerminal(session);
        }
        throw new ResumableUploadError("UPLOAD_CANCELLED", "Upload cancelled.", 409);
    }

    private finish(session: UploadSessionDto): UploadSessionDto {
        this.session = session;
        removeStoredResumableUpload(session.uploadId, this.storage);
        this.publish("complete", "Upload finalized successfully.");
        return session;
    }

    private handleTerminal(session: UploadSessionDto): never {
        this.session = session;
        if (session.status === "cancelled" || session.status === "expired") {
            removeStoredResumableUpload(session.uploadId, this.storage);
        }
        const state = mapBackendState(session.status);
        const code = session.error?.code ?? `UPLOAD_${session.status.toUpperCase()}`;
        const error = new ResumableUploadError(
            code,
            session.error?.message ?? `Upload session is ${session.status}.`,
            session.status === "expired" ? 410 : 409,
            session.error?.retryable ?? false,
        );
        this.publish(state, this.userMessage(error));
        throw error;
    }

    private async getSession(uploadId: string): Promise<UploadSessionDto> {
        return this.requestWithRetry<UploadSessionDto>(`/api/uploads/${encodeURIComponent(uploadId)}`);
    }

    private async requestWithRetry<T>(url: string, init: RequestInit = {}): Promise<T> {
        let lastError: ResumableUploadError | undefined;
        for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt += 1) {
            if (this.cancelled) throw new ResumableUploadError("UPLOAD_CANCELLED", "Upload cancelled.", 409);
            if (attempt > 0) {
                this.publish("retrying", `Retrying request (${attempt}/${this.retryDelaysMs.length})…`);
                await this.delay(this.retryDelaysMs[attempt - 1]!);
            }
            try {
                return await this.requestJson<T>(url, init);
            } catch (error) {
                const normalized = this.normalizeError(error);
                lastError = normalized;
                if (!this.shouldRetry(normalized) || attempt === this.retryDelaysMs.length) throw normalized;
            }
        }
        throw lastError ?? new ResumableUploadError("NETWORK_FAILURE", "Upload request failed.", 0, true);
    }

    private async requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
        const controller = new AbortController();
        this.activeControllers.add(controller);
        try {
            const response = await this.fetchImplementation(url, { ...init, signal: controller.signal });
            if (!response.ok) throw await this.responseError(response, url);
            return await response.json() as T;
        } catch (error) {
            if (error instanceof ResumableUploadError) throw error;
            if (this.cancelled || (error instanceof DOMException && error.name === "AbortError")) {
                throw new ResumableUploadError("UPLOAD_CANCELLED", "Upload cancelled.", 409);
            }
            throw new ResumableUploadError("NETWORK_FAILURE", "The network request failed. You can resume this upload.", 0, true);
        } finally {
            this.activeControllers.delete(controller);
        }
    }

    private async responseError(response: Response, requestUrl = ""): Promise<ResumableUploadError> {
        const body = await response.json().catch(() => ({})) as BackendErrorBody;
        const details = typeof body.error === "object" ? body.error : undefined;
        const createEndpointMissing = response.status === 404
            && /\/api\/projects\/[^/]+\/uploads$/.test(requestUrl);
        return new ResumableUploadError(
            createEndpointMissing ? "UPLOAD_API_UNAVAILABLE" : (details?.code ?? `HTTP_${response.status}`),
            createEndpointMissing
                ? "The connected Hub backend does not provide the resumable upload API. Update and restart the converter backend."
                : (details?.message ?? (typeof body.error === "string" ? body.error : `Request failed with status ${response.status}.`)),
            response.status,
            details?.retryable ?? response.status >= 500,
        );
    }

    private shouldRetry(error: ResumableUploadError): boolean {
        return error.retryable || error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500;
    }

    private normalizeError(error: unknown): ResumableUploadError {
        return error instanceof ResumableUploadError
            ? error
            : new ResumableUploadError("UPLOAD_FAILURE", error instanceof Error ? error.message : String(error));
    }

    private userMessage(error: ResumableUploadError): string {
        if (error.code === "PART_CONFLICT") return "The selected file differs from data already uploaded for this session.";
        if (error.code === "UPLOAD_API_UNAVAILABLE") return error.message;
        if (error.code === "UPLOAD_NOT_FOUND" || error.status === 404) return "The upload session no longer exists.";
        if (error.code.includes("EXPIRED") || error.status === 410) return "The upload expired. Start a new upload.";
        if (error.code.includes("CANCELLED")) return "Upload cancelled.";
        if (error.code.includes("HASH") || error.code.includes("INTEGRITY") || error.code.includes("FINAL")) {
            return "The upload could not be finalized safely.";
        }
        if (error.status === 0) {
            return "The resumable upload API could not be reached. Check the Viewer proxy target and confirm the R2B.3 backend is running.";
        }
        return error.message;
    }

    private publish(state: ResumableUploadState, message?: string, fallbackFile?: File): void {
        this.state = state;
        const totalBytes = this.session?.totalBytes ?? fallbackFile?.size ?? this.file?.size ?? this.stored?.size ?? 0;
        const receivedBytes = Math.min(totalBytes, this.session?.receivedBytes ?? 0);
        this.onChange({
            uploadId: this.session?.uploadId ?? this.stored?.uploadId,
            filename: this.session?.filename ?? fallbackFile?.name ?? this.file?.name ?? this.stored?.filename ?? "Upload",
            totalBytes,
            receivedBytes,
            completedParts: this.session?.uploadedParts.length ?? 0,
            totalParts: this.session?.totalParts ?? 0,
            percent: totalBytes > 0 ? Math.min(100, (receivedBytes / totalBytes) * 100) : 0,
            state: this.state,
            message,
            finalSha256: this.session?.finalSha256,
        });
    }

    private persistOrClean(session: UploadSessionDto): void {
        if (session.status === "complete" || session.status === "cancelled" || session.status === "expired") {
            removeStoredResumableUpload(session.uploadId, this.storage);
        } else if (this.stored) {
            storeResumableUpload(this.stored, this.storage);
        }
    }

    private validateFile(file: File): void {
        if (!Number.isSafeInteger(file.size) || file.size <= 0) {
            throw new ResumableUploadError("INVALID_FILE_SIZE", "Choose a non-empty file.", 400);
        }
        if (file.size > VIEWER_RESUMABLE_UPLOAD_MAX_BYTES) {
            throw new ResumableUploadError("UPLOAD_TOO_LARGE", "The selected file exceeds the 50 GiB upload limit.", 413);
        }
    }

    private requireSession(): UploadSessionDto {
        if (!this.session) throw new Error("Upload session is not initialized.");
        return this.session;
    }

    private requireFile(): File {
        if (!this.file) throw new Error("Upload file is not available.");
        return this.file;
    }
}
