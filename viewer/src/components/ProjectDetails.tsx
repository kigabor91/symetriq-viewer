import { useEffect, useState } from "react";
import type { Project, ProjectFile } from "../models/Project";
import {
    cancelProjectFile,
    deleteProjectFile,
    getProject,
    replaceProjectFile,
    retryProjectFile,
    updateProject,
    updateProjectPlanSettings,
    uploadProjectFiles,
} from "../services/ProjectService";

interface ProjectDetailsProps {
    projectId: string;
    onBack: () => void;
    onOpenScene: () => void;
}

function getStatusLabel(file: ProjectFile): string {
    if (file.status === "queued") return "Queued";
    if (file.status === "processing") return "Converting";
    if (file.status === "ready") return "Ready";
    if (file.status === "cancelled") return "Cancelled";
    return "Failed";
}

export function ProjectDetails({ projectId, onBack, onOpenScene }: ProjectDetailsProps) {
    const [project, setProject] = useState<Project | null>(null);
    const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
    const [isUploading, setIsUploading] = useState(false);
    const [activeFileActionId, setActiveFileActionId] = useState<string | null>(null);
    const [error, setError] = useState("");
    const [isEditingProject, setIsEditingProject] = useState(false);
    const [projectName, setProjectName] = useState("");
    const [projectDescription, setProjectDescription] = useState("");

    useEffect(() => {
        let active = true;
        const refresh = async () => {
            try {
                const latestProject = await getProject(projectId);
                if (active) setProject(latestProject);
            } catch (loadError) {
                if (active) setError(loadError instanceof Error ? loadError.message : String(loadError));
            }
        };
        void refresh();
        const timer = window.setInterval(() => void refresh(), 2000);
        return () => {
            active = false;
            window.clearInterval(timer);
        };
    }, [projectId]);

    const uploadFiles = async () => {
        if (selectedFiles.length === 0) return;
        setIsUploading(true);
        setError("");
        try {
            setProject(await uploadProjectFiles(projectId, selectedFiles));
            setSelectedFiles([]);
        } catch (uploadError) {
            setError(uploadError instanceof Error ? uploadError.message : String(uploadError));
        } finally {
            setIsUploading(false);
        }
    };

    const readyFiles = project?.files.filter((file) => file.status === "ready") ?? [];
    const convertingFiles = project?.files.some(
        (file) => file.status === "queued" || file.status === "processing",
    );

    const deleteFile = async (file: ProjectFile) => {
        if (!window.confirm(`Delete "${file.originalName}" from this project?`)) {
            return;
        }
        setActiveFileActionId(file.id);
        setError("");
        try {
            setProject(await deleteProjectFile(projectId, file.id));
        } catch (deleteError) {
            setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
        } finally {
            setActiveFileActionId(null);
        }
    };

    const replaceFile = async (file: ProjectFile, replacement: File | undefined) => {
        if (!replacement) return;
        setActiveFileActionId(file.id);
        setError("");
        try {
            setProject(await replaceProjectFile(projectId, file.id, replacement));
        } catch (replaceError) {
            setError(replaceError instanceof Error ? replaceError.message : String(replaceError));
        } finally {
            setActiveFileActionId(null);
        }
    };

    const retryFile = async (file: ProjectFile) => {
        setActiveFileActionId(file.id);
        setError("");
        try {
            setProject(await retryProjectFile(projectId, file.id));
        } catch (retryError) {
            setError(retryError instanceof Error ? retryError.message : String(retryError));
        } finally {
            setActiveFileActionId(null);
        }
    };

    const cancelFile = async (file: ProjectFile) => {
        setActiveFileActionId(file.id);
        setError("");
        try {
            setProject(await cancelProjectFile(projectId, file.id));
        } catch (cancelError) {
            setError(cancelError instanceof Error ? cancelError.message : String(cancelError));
        } finally {
            setActiveFileActionId(null);
        }
    };

    const startProjectEditing = () => {
        setProjectName(project?.name ?? "");
        setProjectDescription(project?.description ?? "");
        setIsEditingProject(true);
    };

    const saveProject = async () => {
        setError("");
        try {
            setProject(await updateProject(projectId, {
                name: projectName.trim(),
                description: projectDescription.trim(),
            }));
            setIsEditingProject(false);
        } catch (saveError) {
            setError(saveError instanceof Error ? saveError.message : String(saveError));
        }
    };

    const setPlanReference = async (file: ProjectFile) => {
        setActiveFileActionId(file.id);
        setError("");
        try {
            setProject(await updateProjectPlanSettings(projectId, { planReferenceModelId: file.id }));
        } catch (settingsError) {
            setError(settingsError instanceof Error ? settingsError.message : String(settingsError));
        } finally {
            setActiveFileActionId(null);
        }
    };

    return (
        <main className="workspace-page">
            <header className="workspace-header project-header">
                <div>
                    <button type="button" className="text-button" onClick={onBack}>Back to projects</button>
                    {isEditingProject ? <div className="project-edit-form">
                        <label>Project name<input value={projectName} onChange={(event) => setProjectName(event.target.value)} required /></label>
                        <label>Description<textarea value={projectDescription} onChange={(event) => setProjectDescription(event.target.value)} rows={3} /></label>
                        <div>
                            <button type="button" className="file-action-button" onClick={() => void saveProject()} disabled={!projectName.trim()}>Save</button>
                            <button type="button" className="file-action-button" onClick={() => setIsEditingProject(false)}>Cancel</button>
                        </div>
                    </div> : <>
                        <h1>{project?.name ?? "Loading project..."}</h1>
                        <p>{project?.description}</p>
                        <button type="button" className="file-action-button" onClick={startProjectEditing}>Edit project</button>
                    </>}
                </div>
                <button
                    type="button"
                    className="primary-button scene-button"
                    disabled={readyFiles.length === 0 || convertingFiles}
                    onClick={onOpenScene}
                >
                    {convertingFiles ? "Processing files..." : "Scene"}
                </button>
            </header>

            <section className="workspace-card upload-card">
                <div>
                    <span className="eyebrow">Automatic processing</span>
                    <h2>Add IFC, point cloud or structured E57</h2>
                    <p>IFC files are converted to XKT automatically. LAS and LAZ files are added directly. Structured E57 files are converted into a point cloud and panorama stations.</p>
                </div>
                <label className="file-dropzone">
                    <input
                        type="file"
                        multiple
                        accept=".ifc,.las,.laz,.e57"
                        onChange={(event) => setSelectedFiles(Array.from(event.target.files ?? []))}
                    />
                    <strong>Choose IFC, LAS, LAZ or E57 files</strong>
                    <span>{selectedFiles.length > 0
                        ? `${selectedFiles.length} file(s) selected`
                        : "Multiple files can be uploaded together"}</span>
                </label>
                <button
                    type="button"
                    className="primary-button"
                    disabled={isUploading || selectedFiles.length === 0}
                    onClick={() => void uploadFiles()}
                >
                    {isUploading ? "Uploading..." : "Upload and process"}
                </button>
            </section>

            {error && <p className="workspace-error">{error}</p>}
            {convertingFiles && (
                <p className="processing-notice">Conversion is running. This page updates automatically.</p>
            )}

            <section className="workspace-card files-card">
                <h2>Project files</h2>
                <div className="file-list">
                    {project?.files.map((file) => (
                        <article key={file.id} className="project-file-row">
                            <div>
                                <strong>{file.originalName}</strong>
                                <span>{file.kind === "ifc" ? "IFC model" : file.kind === "structured-e57" ? "Structured E57 / panoramas" : "Point cloud"}</span>
                            </div>
                            <span className={`file-status status-${file.status}`}>{getStatusLabel(file)}</span>
                            <div className="project-file-actions">
                                {file.kind === "ifc" && file.status === "ready" && (
                                    <button
                                        type="button"
                                        className={project.planReferenceModelId === file.id ? "file-action-button is-active" : "file-action-button"}
                                        disabled={activeFileActionId !== null}
                                        onClick={() => void setPlanReference(file)}
                                    >
                                        {project.planReferenceModelId === file.id ? "Plan reference" : "Use as plan reference"}
                                    </button>
                                )}
                                {(file.status === "error" || file.status === "cancelled") && file.kind !== "point-cloud" && (
                                    <button
                                        type="button"
                                        className="file-action-button"
                                        disabled={activeFileActionId !== null}
                                        onClick={() => void retryFile(file)}
                                    >
                                        {activeFileActionId === file.id ? "Working..." : "Retry"}
                                    </button>
                                )}
                                {(file.status === "queued" || file.status === "processing") && (
                                    <button
                                        type="button"
                                        className="file-action-button delete-file-button"
                                        disabled={activeFileActionId !== null}
                                        onClick={() => void cancelFile(file)}
                                    >
                                        {activeFileActionId === file.id ? "Cancelling..." : "Cancel conversion"}
                                    </button>
                                )}
                                <label
                                    className={file.status === "ready" || file.status === "error" || file.status === "cancelled"
                                        ? "file-action-button"
                                        : "file-action-button is-disabled"}
                                >
                                    {activeFileActionId === file.id ? "Working..." : "Replace"}
                                    <input
                                        type="file"
                                        accept={file.kind === "ifc"
                                            ? ".ifc"
                                            : file.kind === "structured-e57"
                                                ? ".e57"
                                                : ".las,.laz"}
                                        disabled={activeFileActionId !== null || (
                                            file.status !== "ready" && file.status !== "error" && file.status !== "cancelled"
                                        )}
                                        onChange={(event) => {
                                            const replacement = event.target.files?.[0];
                                            event.target.value = "";
                                            void replaceFile(file, replacement);
                                        }}
                                    />
                                </label>
                                <button
                                    type="button"
                                    className="file-action-button delete-file-button"
                                    disabled={activeFileActionId !== null || (
                                        file.status !== "ready" && file.status !== "error" && file.status !== "cancelled"
                                    )}
                                    onClick={() => void deleteFile(file)}
                                >
                                    Delete
                                </button>
                            </div>
                            {file.error && <small>{file.error}</small>}
                        </article>
                    ))}
                    {project?.files.length === 0 && <p className="empty-state">No files uploaded yet.</p>}
                </div>
            </section>
        </main>
    );
}
