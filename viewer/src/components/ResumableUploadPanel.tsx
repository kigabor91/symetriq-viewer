import { useEffect, useRef, useState } from "react";
import {
    fileMatchesStoredUpload,
    inferResumableFileKind,
    listStoredResumableUploads,
    ResumableUploadClient,
    type ResumableUploadSnapshot,
    type StoredResumableUpload,
} from "../services/ResumableUploadService";

interface ResumableUploadPanelProps {
    projectId: string;
}

function formatBytes(bytes: number): string {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${bytes} B`;
}

function statusLabel(snapshot: ResumableUploadSnapshot): string {
    if (snapshot.state === "creating-session") return "Creating upload session…";
    if (snapshot.state === "uploading") return "Uploading…";
    if (snapshot.state === "retrying") return "Retrying…";
    if (snapshot.state === "recoverable") return "Paused – file can be reselected and resumed";
    if (snapshot.state === "finalizing") return "Finalizing…";
    if (snapshot.state === "complete") return "Finalized successfully";
    if (snapshot.state === "cancelled") return "Cancelled";
    if (snapshot.state === "expired") return "Expired";
    if (snapshot.state === "failed") return "Failed";
    return "Ready";
}

export function ResumableUploadPanel({ projectId }: ResumableUploadPanelProps) {
    const [selectedFile, setSelectedFile] = useState<File>();
    const [storedUploads, setStoredUploads] = useState<StoredResumableUpload[]>(() => (
        listStoredResumableUploads().filter((entry) => entry.projectId === projectId)
    ));
    const [snapshots, setSnapshots] = useState<Record<string, ResumableUploadSnapshot>>({});
    const [error, setError] = useState("");
    const clients = useRef(new Map<string, ResumableUploadClient>());
    const mounted = useRef(true);

    const refreshStored = () => {
        if (mounted.current) {
            setStoredUploads(listStoredResumableUploads().filter((entry) => entry.projectId === projectId));
        }
    };

    useEffect(() => {
        mounted.current = true;
        return () => {
            // Deliberately do not cancel server sessions when navigating away.
            mounted.current = false;
        };
    }, []);

    const createClient = (key: string, idempotencyKey?: string) => {
        const client = new ResumableUploadClient({
            ...(idempotencyKey ? { idFactory: () => idempotencyKey } : {}),
            onChange: (snapshot) => {
                if (!mounted.current) return;
                setSnapshots((current) => ({ ...current, [key]: snapshot }));
                if (["complete", "cancelled", "expired"].includes(snapshot.state)) refreshStored();
            },
        });
        clients.current.set(key, client);
        return client;
    };

    const start = async () => {
        if (!selectedFile) return;
        const file = selectedFile;
        const kind = inferResumableFileKind(file.name);
        if (!kind) {
            setError("Choose an IFC, E57, LAS or LAZ file.");
            return;
        }
        const key = crypto.randomUUID();
        setSelectedFile(undefined);
        setError("");
        try {
            await createClient(key, key).start(projectId, file, kind);
        } catch (uploadError) {
            setError(uploadError instanceof Error ? uploadError.message : String(uploadError));
        } finally {
            refreshStored();
        }
    };

    const resume = async (stored: StoredResumableUpload, file: File | undefined) => {
        if (!file) return;
        setError("");
        if (!fileMatchesStoredUpload(file, stored)) {
            setError(`Reselected file does not match ${stored.filename}.`);
            return;
        }
        try {
            await createClient(stored.uploadId ?? stored.idempotencyKey).resume(stored, file);
        } catch (uploadError) {
            setError(uploadError instanceof Error ? uploadError.message : String(uploadError));
        } finally {
            refreshStored();
        }
    };

    const cancelActive = async (key: string) => {
        try {
            await clients.current.get(key)?.cancel();
        } catch (cancelError) {
            setError(cancelError instanceof Error ? cancelError.message : String(cancelError));
        } finally {
            refreshStored();
        }
    };

    const retryActive = async (key: string) => {
        setError("");
        try {
            await clients.current.get(key)?.retry();
        } catch (retryError) {
            setError(retryError instanceof Error ? retryError.message : String(retryError));
        } finally {
            refreshStored();
        }
    };

    const discardStored = async (stored: StoredResumableUpload) => {
        setError("");
        try {
            await createClient(stored.uploadId ?? stored.idempotencyKey).discard(stored);
        } catch (discardError) {
            setError(discardError instanceof Error ? discardError.message : String(discardError));
        } finally {
            refreshStored();
        }
    };

    return (
        <section className="workspace-card resumable-upload-card">
            <div>
                <span className="eyebrow">Development transport test</span>
                <h2>Resumable large-file upload</h2>
                <p>This verifies chunk upload and server finalization only. Project registration and conversion arrive in R2B.5.</p>
            </div>
            <div className="resumable-upload-picker">
                <label className="file-dropzone">
                    <input
                        type="file"
                        accept=".ifc,.las,.laz,.e57"
                        onChange={(event) => setSelectedFile(event.target.files?.[0])}
                    />
                    <strong>Choose a large file</strong>
                    <span>{selectedFile ? `${selectedFile.name} · ${formatBytes(selectedFile.size)}` : "IFC, E57, LAS or LAZ"}</span>
                </label>
                <button type="button" className="primary-button" disabled={!selectedFile} onClick={() => void start()}>
                    Start resumable test
                </button>
            </div>

            {Object.entries(snapshots).map(([key, snapshot]) => (
                <article className="resumable-upload-item" key={key}>
                    <div className="resumable-upload-heading">
                        <strong>{snapshot.filename}</strong>
                        <span>{statusLabel(snapshot)}</span>
                    </div>
                    <progress max={100} value={snapshot.percent}>{snapshot.percent.toFixed(1)}%</progress>
                    <small>
                        {snapshot.percent.toFixed(1)}% · {formatBytes(snapshot.receivedBytes)} / {formatBytes(snapshot.totalBytes)} · {snapshot.completedParts}/{snapshot.totalParts} parts
                    </small>
                    {snapshot.message && <small>{snapshot.message}</small>}
                    {!(["complete", "cancelled", "expired"].includes(snapshot.state)) && (
                        <div className="resumable-upload-actions">
                            {snapshot.state === "recoverable" && (
                                <button type="button" className="file-action-button" onClick={() => void retryActive(key)}>
                                    Retry / resume
                                </button>
                            )}
                            <button type="button" className="file-action-button delete-file-button" onClick={() => void cancelActive(key)}>
                                Cancel upload
                            </button>
                        </div>
                    )}
                </article>
            ))}

            {storedUploads.filter((stored) => (
                snapshots[stored.idempotencyKey] === undefined
                && (stored.uploadId === undefined || snapshots[stored.uploadId] === undefined)
                && !Object.values(snapshots).some(
                    (snapshot) => snapshot.uploadId !== undefined && snapshot.uploadId === stored.uploadId,
                )
            )).map((stored) => (
                <article className="resumable-upload-item" key={stored.uploadId ?? stored.idempotencyKey}>
                    <div className="resumable-upload-heading">
                        <strong>{stored.filename}</strong>
                        <span>Reselect the original file to resume</span>
                    </div>
                    <small>{formatBytes(stored.size)} · {stored.uploadId ? `session ${stored.uploadId}` : "session creation can be resumed"}</small>
                    <div className="resumable-upload-actions">
                        <label className="file-action-button">
                            Reselect and resume
                            <input
                                type="file"
                                accept=".ifc,.las,.laz,.e57"
                                onChange={(event) => {
                                    const file = event.target.files?.[0];
                                    event.target.value = "";
                                    void resume(stored, file);
                                }}
                            />
                        </label>
                        <button type="button" className="file-action-button delete-file-button" onClick={() => void discardStored(stored)}>
                            Cancel and discard
                        </button>
                    </div>
                </article>
            ))}
            {error && <p className="workspace-error resumable-upload-error">{error}</p>}
        </section>
    );
}
