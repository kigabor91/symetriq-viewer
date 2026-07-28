import { useEffect, useState, type FormEvent } from "react";
import type { Project } from "../models/Project";
import { createProject, deleteProject, listProjects } from "../services/ProjectService";

interface ProjectDashboardProps {
    onOpenProject: (projectId: string) => void;
}

export function ProjectDashboard({ onOpenProject }: ProjectDashboardProps) {
    const [projects, setProjects] = useState<Project[]>([]);
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [isCreating, setIsCreating] = useState(false);
    const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
    const [error, setError] = useState("");

    useEffect(() => {
        void listProjects()
            .then(setProjects)
            .catch((loadError: unknown) => setError(
                loadError instanceof Error ? loadError.message : String(loadError),
            ));
    }, []);

    const submitProject = async (event: FormEvent) => {
        event.preventDefault();
        setIsCreating(true);
        setError("");
        try {
            const project = await createProject(name, description);
            onOpenProject(project.id);
        } catch (createError) {
            setError(createError instanceof Error ? createError.message : String(createError));
        } finally {
            setIsCreating(false);
        }
    };

    const removeProject = async (project: Project) => {
        if (!window.confirm(
            `Delete project "${project.name}" and all of its uploaded files, conversions and issues?`,
        )) {
            return;
        }
        setDeletingProjectId(project.id);
        setError("");
        try {
            await deleteProject(project.id);
            setProjects((current) => current.filter((candidate) => candidate.id !== project.id));
        } catch (deleteError) {
            setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
        } finally {
            setDeletingProjectId(null);
        }
    };

    return (
        <main className="workspace-page">
            <header className="workspace-header">
                <div>
                    <span className="eyebrow">SymetrIQ workspace</span>
                    <h1>Projects</h1>
                    <p>Create a project, upload BIM and survey data, then open the combined scene.</p>
                </div>
            </header>

            <section className="workspace-card create-project-card">
                <h2>Create project</h2>
                <form onSubmit={(event) => void submitProject(event)}>
                    <label>
                        Project name
                        <input value={name} onChange={(event) => setName(event.target.value)} required />
                    </label>
                    <label>
                        Description
                        <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} />
                    </label>
                    <button type="submit" className="primary-button" disabled={isCreating}>
                        {isCreating ? "Creating..." : "Create project"}
                    </button>
                </form>
            </section>

            {error && <p className="workspace-error">{error}</p>}

            <section className="project-grid" aria-label="Projects">
                {projects.map((project) => {
                    const readyFiles = project.files.filter((file) => file.status === "ready").length;
                    return (
                        <article key={project.id} className="workspace-card project-card">
                            <span className="eyebrow">{readyFiles} ready files</span>
                            <h2>{project.name}</h2>
                            <p>{project.description || "No description"}</p>
                            <button type="button" onClick={() => onOpenProject(project.id)}>
                                Open project
                            </button>
                            <button
                                type="button"
                                className="delete-project-button"
                                disabled={deletingProjectId !== null}
                                onClick={() => void removeProject(project)}
                            >
                                {deletingProjectId === project.id ? "Deleting..." : "Delete"}
                            </button>
                        </article>
                    );
                })}
                {projects.length === 0 && !error && (
                    <p className="empty-state">No projects yet. Create the first SymetrIQ project above.</p>
                )}
            </section>
        </main>
    );
}
