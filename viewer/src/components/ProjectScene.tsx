import { useEffect, useMemo, useState } from "react";
import type { Project } from "../models/Project";
import { getProject, updateProjectPlanSettings } from "../services/ProjectService";
import Viewer from "./Viewer";
import type { PanoramaStation } from "./PanoramaOverlay";

interface ProjectSceneProps {
    projectId: string;
    onBack: () => void;
}

export function ProjectScene({ projectId, onBack }: ProjectSceneProps) {
    const [project, setProject] = useState<Project | null>(null);
    const [error, setError] = useState("");

    useEffect(() => {
        void getProject(projectId)
            .then(setProject)
            .catch((loadError: unknown) => setError(
                loadError instanceof Error ? loadError.message : String(loadError),
            ));
    }, [projectId]);

    const sceneFilesKey = project?.files.map((file) => [
        file.id,
        file.status,
        file.model?.geometry.src,
        file.pointCloud?.source.src,
        file.panorama?.stations.length,
    ].join("|")).join(";") ?? "";

    const models = useMemo(
        () => project?.files.flatMap((file) => file.status === "ready" && file.model
            ? [{ ...file.model, displayName: file.originalName }]
            : []) ?? [],
        [sceneFilesKey],
    );
    const pointClouds = useMemo(
        () => project?.files.flatMap(
            (file) => file.status === "ready" && file.pointCloud
                ? [{ ...file.pointCloud, displayName: file.originalName }]
                : [],
        ) ?? [],
        [sceneFilesKey],
    );
    const panoramaStations = useMemo(() => project?.files.flatMap((file) =>
        file.status === "ready" && file.panorama
            ? file.panorama.stations.map((station): PanoramaStation => ({
                ...station,
                sourceName: file.originalName,
            }))
            : [],
    ) ?? [], [sceneFilesKey]);

    if (error) return <main className="workspace-page"><p className="workspace-error">{error}</p></main>;
    if (!project) return <main className="workspace-page"><p>Loading scene...</p></main>;

    return (
        <Viewer
            projectId={projectId}
            modelPackages={models}
            pointCloudPackages={pointClouds}
            panoramaStations={panoramaStations}
            planReferenceModelId={project.planReferenceModelId}
            planViewRange={project.planViewRange}
            onPlanViewRangeChange={(planViewRange) => void updateProjectPlanSettings(projectId, { planViewRange }).then(setProject)}
            onExit={onBack}
        />
    );
}
