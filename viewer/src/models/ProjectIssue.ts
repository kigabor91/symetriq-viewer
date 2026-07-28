import type { ElementSelection } from "./ModelPackage";

export interface ProjectIssueComment {
    id: string;
    authorName: string;
    body: string;
    createdAt: string;
}

export interface ProjectIssue {
    id: string;
    title: string;
    description: string;
    status: "open" | "resolved" | "closed";
    createdAt: string;
    updatedAt: string;
    screenshotSrc: string;
    viewpoint: Record<string, unknown>;
    packageVisibility: Record<string, boolean>;
    selection?: ElementSelection;
    category?: string;
    comments?: ProjectIssueComment[];
}

export interface CreateProjectIssue {
    title: string;
    description: string;
    screenshotData: string;
    viewpoint: Record<string, unknown>;
    packageVisibility: Record<string, boolean>;
    selection?: ElementSelection;
    category?: string;
}

export interface UpdateProjectIssue {
    status?: ProjectIssue["status"];
    title?: string;
    description?: string;
    category?: string;
}
