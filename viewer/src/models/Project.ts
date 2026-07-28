import type { ModelPackage, PointCloudPackage } from "./ModelPackage";
import type { ProjectIssue } from "./ProjectIssue";
import type { ProjectPropertyView } from "./ProjectPropertyView";
import type { ProjectDisplayView } from "./ProjectDisplayView";

export type ProjectFileStatus = "queued" | "processing" | "ready" | "error" | "cancelled";

export interface ProjectFile {
    id: string;
    originalName: string;
    kind: "ifc" | "point-cloud" | "structured-e57";
    status: ProjectFileStatus;
    error?: string;
    model?: ModelPackage;
    pointCloud?: PointCloudPackage;
    panorama?: {
        stations: Array<{
            id: string;
            name: string;
            sourceData3DGuid: string;
            position: [number, number, number];
            rotation: [number, number, number, number];
            faces: string[];
        }>;
    };
}

export interface Project {
    id: string;
    name: string;
    description: string;
    createdAt: string;
    updatedAt: string;
    files: ProjectFile[];
    issues?: ProjectIssue[];
    propertyViews?: ProjectPropertyView[];
    displayViews?: ProjectDisplayView[];
    planReferenceModelId?: string;
    planViewRange?: { lower: number; cut: number; upper: number };
}
