import type { Project } from "../models/Project";
import type { CreateProjectIssue, ProjectIssue, UpdateProjectIssue } from "../models/ProjectIssue";
import type { ProjectPropertyView } from "../models/ProjectPropertyView";
import type { ProjectDisplayView } from "../models/ProjectDisplayView";

async function readResponse<T>(response: Response): Promise<T> {
    if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Request failed with status ${response.status}.`);
    }
    return response.json() as Promise<T>;
}

export async function listProjects(): Promise<Project[]> {
    return readResponse<Project[]>(await fetch("/api/projects"));
}

export async function createProject(
    name: string,
    description: string,
): Promise<Project> {
    return readResponse<Project>(await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description }),
    }));
}

export async function getProject(projectId: string): Promise<Project> {
    return readResponse<Project>(await fetch(`/api/projects/${projectId}`));
}

export async function updateProject(
    projectId: string,
    changes: { name: string; description: string },
): Promise<Project> {
    return readResponse<Project>(await fetch(`/api/projects/${projectId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
    }));
}

export async function updateProjectPlanSettings(
    projectId: string,
    settings: { planReferenceModelId?: string; planViewRange?: { lower: number; cut: number; upper: number } },
): Promise<Project> {
    return readResponse<Project>(await fetch(`/api/projects/${projectId}/plan-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
    }));
}

export async function deleteProject(projectId: string): Promise<void> {
    const response = await fetch(`/api/projects/${projectId}`, { method: "DELETE" });
    if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Request failed with status ${response.status}.`);
    }
}

export async function listProjectPropertyViews(projectId: string): Promise<ProjectPropertyView[]> {
    return readResponse<ProjectPropertyView[]>(
        await fetch(`/api/projects/${projectId}/property-views`),
    );
}

export async function createProjectPropertyView(
    projectId: string,
    name: string,
    propertyKeys: string[],
): Promise<ProjectPropertyView> {
    return readResponse<ProjectPropertyView>(await fetch(
        `/api/projects/${projectId}/property-views`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, propertyKeys }),
        },
    ));
}

export async function deleteProjectPropertyView(
    projectId: string,
    viewId: string,
): Promise<void> {
    const response = await fetch(`/api/projects/${projectId}/property-views/${viewId}`, {
        method: "DELETE",
    });
    if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Request failed with status ${response.status}.`);
    }
}

export async function listProjectDisplayViews(projectId: string): Promise<ProjectDisplayView[]> {
    return readResponse<ProjectDisplayView[]>(await fetch(`/api/projects/${projectId}/display-views`));
}

export async function createProjectDisplayView(
    projectId: string,
    view: Omit<ProjectDisplayView, "id" | "createdAt">,
): Promise<ProjectDisplayView> {
    return readResponse<ProjectDisplayView>(await fetch(`/api/projects/${projectId}/display-views`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(view),
    }));
}

export async function deleteProjectDisplayView(projectId: string, viewId: string): Promise<void> {
    const response = await fetch(`/api/projects/${projectId}/display-views/${viewId}`, { method: "DELETE" });
    if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Request failed with status ${response.status}.`);
    }
}

export async function uploadProjectFiles(
    projectId: string,
    files: File[],
): Promise<Project> {
    const body = new FormData();
    files.forEach((file) => body.append("files", file));
    return readResponse<Project>(await fetch(`/api/projects/${projectId}/files`, {
        method: "POST",
        body,
    }));
}

export async function deleteProjectFile(
    projectId: string,
    fileId: string,
): Promise<Project> {
    return readResponse<Project>(await fetch(`/api/projects/${projectId}/files/${fileId}`, {
        method: "DELETE",
    }));
}

export async function retryProjectFile(
    projectId: string,
    fileId: string,
): Promise<Project> {
    return readResponse<Project>(await fetch(
        `/api/projects/${projectId}/files/${fileId}/retry`,
        { method: "POST" },
    ));
}

export async function cancelProjectFile(
    projectId: string,
    fileId: string,
): Promise<Project> {
    return readResponse<Project>(await fetch(
        `/api/projects/${projectId}/files/${fileId}/cancel`,
        { method: "POST" },
    ));
}

export async function replaceProjectFile(
    projectId: string,
    fileId: string,
    file: File,
): Promise<Project> {
    const body = new FormData();
    body.append("file", file);
    return readResponse<Project>(await fetch(
        `/api/projects/${projectId}/files/${fileId}/replace`,
        { method: "POST", body },
    ));
}

export async function listProjectIssues(projectId: string): Promise<ProjectIssue[]> {
    return readResponse<ProjectIssue[]>(
        await fetch(`/api/projects/${projectId}/issues`),
    );
}

export async function createProjectIssue(
    projectId: string,
    issue: CreateProjectIssue,
): Promise<ProjectIssue> {
    return readResponse<ProjectIssue>(await fetch(`/api/projects/${projectId}/issues`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(issue),
    }));
}

export async function updateProjectIssueStatus(
    projectId: string,
    issueId: string,
    status: ProjectIssue["status"],
): Promise<ProjectIssue> {
    return updateProjectIssue(projectId, issueId, { status });
}

export async function updateProjectIssue(
    projectId: string,
    issueId: string,
    changes: UpdateProjectIssue,
): Promise<ProjectIssue> {
    return readResponse<ProjectIssue>(await fetch(
        `/api/projects/${projectId}/issues/${issueId}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(changes),
        },
    ));
}

export async function addProjectIssueComment(
    projectId: string,
    issueId: string,
    comment: { authorName: string; body: string },
): Promise<ProjectIssue> {
    return readResponse<ProjectIssue>(await fetch(
        `/api/projects/${projectId}/issues/${issueId}/comments`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(comment),
        },
    ));
}
