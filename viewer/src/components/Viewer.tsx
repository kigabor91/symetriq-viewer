import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelElement, ModelMetadata, ModelPropertySet } from "../models/ModelMetadata";
import type {
    ElementActionContext,
    ElementSelection,
    ModelPackage,
    PointCloudPackage,
} from "../models/ModelPackage";
import type { ProjectIssue } from "../models/ProjectIssue";
import type { ProjectPropertyView } from "../models/ProjectPropertyView";
import type { DisplayMode, ProjectDisplayView } from "../models/ProjectDisplayView";
import { loadModelMetadata } from "../services/MetadataService";
import {
    addProjectIssueComment,
    createProjectIssue,
    createProjectPropertyView,
    createProjectDisplayView,
    deleteProjectDisplayView,
    deleteProjectPropertyView,
    listProjectIssues,
    listProjectPropertyViews,
    listProjectDisplayViews,
    getPublishedElementProperties,
    getCanonicalPropertyMatches,
    getCanonicalPropertyValues,
    getPropertyDefinitionCatalog,
    type PropertyDefinitionCatalogEntry,
    updateProjectIssue,
    updateProjectIssueStatus,
} from "../services/ProjectService";
import { ViewerService } from "../services/ViewerService";
import { PanoramaOverlay, type PanoramaStation } from "./PanoramaOverlay";

const VISIBLE_PROPERTIES_STORAGE_KEY = "symetriq.visible-property-keys.v1";
// Changing this revision deliberately recreates the xeokit scene during Vite
// hot reload. Without it, React Fast Refresh can retain a previous
// ViewerService instance (and its renderer-owned panorama markers) even after
// the implementation changes to DOM-only markers.
const VIEWER_RUNTIME_REVISION = "panorama-dom-markers-v2";
const DEFAULT_PROPERTY_NAMES = [
    "Overall Size",
    "Diameter",
    "Length",
    "Material",
    "System Type",
    "Reference",
    "Area",
    "Volume",
];

interface AvailableProperty {
    key: string;
    propertySetName: string;
    propertyName: string;
}

interface FilterValue {
    id: string;
    value: string;
    count: number;
}

function encodeModelValueId(modelId: string, valueId: string): string {
    return `${modelId}|${valueId}`;
}

function decodeModelValueId(id: string): { modelId: string; valueId: string } | null {
    const separator = id.indexOf("|");
    return separator > 0 ? { modelId: id.slice(0, separator), valueId: id.slice(separator + 1) } : null;
}

interface PanoramaMarkerLayout {
    id: string;
    canvasPos: [number, number];
    visible: boolean;
}

function getPropertyKey(propertySetName: string, propertyName: string): string {
    return `${propertySetName}::${propertyName}`;
}

function propertyDefinitionKey(propertySet: ModelPropertySet, property: ModelPropertySet["properties"][number]): string {
    if (propertySet.name === "Revit Identity" && ["Category", "Family", "Type"].includes(property.name)) {
        return `canonical:facet:${property.name.toLocaleLowerCase()}`;
    }
    return property.propertyDefinitionId ?? `canonical:instance:${propertySet.name}:${property.name}`;
}

function getDefaultPropertyKeys(properties: AvailableProperty[]): string[] {
    const namedDefaults = properties
        .filter((property) => DEFAULT_PROPERTY_NAMES.includes(property.propertyName))
        .map((property) => property.key);
    return namedDefaults.length > 0
        ? namedDefaults
        : properties.slice(0, 12).map((property) => property.key);
}

/** Keeps older name-based saved views usable while all new views persist canonical IDs. */
function normalizePropertyKeys(keys: string[], properties: AvailableProperty[]): string[] {
    return keys.map((key) => {
        if (key.startsWith("canonical:")) return key;
        const matching = properties.find((property) => getPropertyKey(property.propertySetName, property.propertyName) === key);
        return matching?.key ?? key;
    });
}

function normalizePropertyKey(key: string, properties: AvailableProperty[]): string {
    return normalizePropertyKeys([key], properties)[0] ?? key;
}

function bootstrapPropertySets(element: ModelElement, metadata: ModelMetadata | undefined): ModelPropertySet[] {
    const stored = element.propertySetIds
        .map((id) => metadata?.propertySets[id])
        .filter((propertySet): propertySet is ModelPropertySet => propertySet !== undefined);
    if (!element.identity) return stored;
    return [{
        id: `bootstrap:${element.globalId}`,
        name: "Revit Identity",
        type: "Revit",
        properties: [
            { name: "Logical Element ID", value: element.identity.logicalElementId, type: "string" },
            { name: "Revit Unique ID", value: element.identity.revitUniqueId, type: "string" },
            { name: "Category", value: element.identity.category, type: "string" },
            { name: "Family", value: element.identity.family, type: "string" },
            { name: "Type", value: element.identity.type, type: "string" },
        ],
    }];
}

function hexToRgb(color: string): [number, number, number] {
    const hex = color.replace("#", "");
    return [0, 2, 4].map((offset) =>
        Number.parseInt(hex.slice(offset, offset + 2), 16) / 255,
    ) as [number, number, number];
}

interface ViewerProps {
    projectId: string;
    modelPackages: ModelPackage[];
    pointCloudPackages: PointCloudPackage[];
    panoramaStations?: PanoramaStation[];
    planReferenceModelId?: string;
    planViewRange?: { lower: number; cut: number; upper: number };
    onPlanViewRangeChange?: (range: { lower: number; cut: number; upper: number }) => void;
    onExit?: () => void;
}

type ViewerTool = "display" | "section" | "measure" | "scene" | "filter" | "plan";
// The 1/10 point-cloud LOD is retained for a future streamed renderer. The
// current browser renderer intentionally exposes only responsive presets.
const showBalancedPointCloudDetail = false;

function ToolIcon({ name }: { name: "view" | "display" | "section" | "section-active" | "measure" | "measure-active" | "scene" | "filter" | "filter-active" | "properties" | "panorama" | "plan" }) {
    const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
    if (name === "view") {
        return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M8 12h8M12 8v8" /></svg>;
    }
    if (name === "display") {
        return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="M4 7h16M4 12h16M4 17h16M7 4v6M12 9v6M17 14v6" /></svg>;
    }
    if (name === "section") {
        return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="M4 4l16 16M20 4L4 20M8 4l12 12M4 8l12 12" /></svg>;
    }
    if (name === "section-active") {
        return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="M4 4l16 16M20 4L4 20M8 4l12 12M4 8l12 12" /><circle cx="18" cy="18" r="3" fill="currentColor" stroke="#1d2630" strokeWidth="1.5" /></svg>;
    }
    if (name === "measure") {
        return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="M4 17L17 4l3 3L7 20l-3-3zM10 11l3 3M13 8l3 3" /></svg>;
    }
    if (name === "measure-active") {
        return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="M4 17L17 4l3 3L7 20l-3-3zM10 11l3 3M13 8l3 3" /><circle cx="18" cy="18" r="3" fill="currentColor" stroke="#1d2630" strokeWidth="1.5" /></svg>;
    }
    if (name === "scene") {
        return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="M12 3l8 4.5-8 4.5-8-4.5L12 3zm-8 9l8 4.5 8-4.5M4 16l8 4.5 8-4.5" /></svg>;
    }
    if (name === "filter") {
        return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="M4 5h16l-6.5 7.5V19l-3 1.5v-8L4 5z" /></svg>;
    }
    if (name === "filter-active") {
        return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="M4 5h16l-6.5 7.5V19l-3 1.5v-8L4 5z" /><circle cx="18" cy="18" r="3" fill="currentColor" stroke="#1d2630" strokeWidth="1.5" /></svg>;
    }
    if (name === "panorama") {
        return <svg viewBox="0 0 24 24" aria-hidden="true"><rect {...common} x="3" y="5" width="18" height="14" rx="2" /><circle {...common} cx="12" cy="12" r="3" /><path {...common} d="M7 5l1-2h8l1 2" /></svg>;
    }
    if (name === "plan") {
        return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="M4 5l5-2 6 3 5-2v15l-5 2-6-3-5 2V5zm5-2v15m6-12v15" /></svg>;
    }
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5" /></svg>;
}

function Viewer({ projectId, modelPackages, pointCloudPackages, panoramaStations = [], planReferenceModelId, planViewRange, onPlanViewRangeChange, onExit }: ViewerProps) {
    const [pointCloudStrides, setPointCloudStrides] = useState<Record<string, number>>({});
    const effectivePointCloudPackages = useMemo(() => pointCloudPackages.map((pointCloud) => {
        // Fast is the common scene default. For structured E57 this selects
        // the pre-sampled spatial LOD; regular LAS/LAZ still uses xeokit's
        // normal every-50th-point loading.
        const requestedDetail = pointCloudStrides[pointCloud.id] ?? 50;
        const spatialLod = pointCloud.lodSources?.[String(requestedDetail)];
        return {
            ...pointCloud,
            source: spatialLod ?? pointCloud.source,
            // A converter-made LOD is already sampled; never apply a second
            // sequential skip over it.
            pointStride: spatialLod ? 1 : requestedDetail,
        };
    }), [pointCloudPackages, pointCloudStrides]);
    const scenePackageControls = useMemo(() => [
        ...modelPackages.map((model) => ({
            id: model.id,
            displayName: model.displayName ?? model.id,
            kind: "IFC / XKT",
            hasSpatialLods: false,
        })),
        ...effectivePointCloudPackages.map((pointCloud) => ({
            id: pointCloud.id,
            displayName: pointCloud.displayName ?? pointCloud.id,
            kind: "Point cloud",
            hasSpatialLods: Boolean(pointCloud.lodSources),
        })),
    ], [modelPackages, effectivePointCloudPackages]);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const viewerServiceRef = useRef<ViewerService | null>(null);
    const pendingPlanRestoreRef = useRef<{
        levelId: string;
        range: { lower: number; cut: number; upper: number };
    } | null>(null);
    const packageVisibilityRef = useRef<Record<string, boolean>>({});
    const catalogRequestedModelIdsRef = useRef(new Set<string>());
    const propertyRetrievalRequestRefs = useRef(new Set<string>());
    const [status, setStatus] = useState("Loading model...");
    const [selection, setSelection] = useState<ElementSelection | null>(null);
    const [elementActionContext, setElementActionContext] = useState<ElementActionContext | null>(null);
    const [metadataByModelId, setMetadataByModelId] = useState<Record<string, ModelMetadata>>({});
    const [isPropertyConfigurationOpen, setIsPropertyConfigurationOpen] = useState(false);
    const [showAllProperties, setShowAllProperties] = useState(false);
    const [retrievedPropertySets, setRetrievedPropertySets] = useState<ModelPropertySet[] | null>(null);
    const [retrievedPropertyReference, setRetrievedPropertyReference] = useState<string | null>(null);
    const [isPropertyRetrievalLoading, setIsPropertyRetrievalLoading] = useState(false);
    const [propertyRetrievalError, setPropertyRetrievalError] = useState("");
    const [propertyDefinitionsByModelId, setPropertyDefinitionsByModelId] = useState<Record<string, PropertyDefinitionCatalogEntry[]>>({});
    const [isPropertyCatalogLoading, setIsPropertyCatalogLoading] = useState(false);
    const [propertyCatalogError, setPropertyCatalogError] = useState("");
    const [propertySearch, setPropertySearch] = useState("");
    const [isCutMode, setIsCutMode] = useState(false);
    const [cutCount, setCutCount] = useState(0);
    const [canFlipCut, setCanFlipCut] = useState(false);
    const [isDistanceMode, setIsDistanceMode] = useState(false);
    const [isEditingMeasurement, setIsEditingMeasurement] = useState(false);
    const [measurementCount, setMeasurementCount] = useState(0);
    const [issues, setIssues] = useState<ProjectIssue[]>([]);
    const [issueDraft, setIssueDraft] = useState<{
        screenshotData: string;
        viewpoint: Record<string, unknown>;
        selection?: ElementSelection;
    } | null>(null);
    const [issueTitle, setIssueTitle] = useState("");
    const [issueDescription, setIssueDescription] = useState("");
    const [issueCategory, setIssueCategory] = useState("");
    const [issueError, setIssueError] = useState("");
    const [isIssueSaving, setIsIssueSaving] = useState(false);
    const [isIssueManagerOpen, setIsIssueManagerOpen] = useState(false);
    const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
    const [issueSearch, setIssueSearch] = useState("");
    const [issueStatusFilter, setIssueStatusFilter] = useState<"all" | ProjectIssue["status"]>("all");
    const [issueCategoryFilter, setIssueCategoryFilter] = useState("all");
    const [isIssueStatusUpdating, setIsIssueStatusUpdating] = useState(false);
    const [isIssueEditing, setIsIssueEditing] = useState(false);
    const [editIssueTitle, setEditIssueTitle] = useState("");
    const [editIssueDescription, setEditIssueDescription] = useState("");
    const [editIssueCategory, setEditIssueCategory] = useState("");
    const [commentAuthorName, setCommentAuthorName] = useState("");
    const [commentBody, setCommentBody] = useState("");
    const [isCommentSaving, setIsCommentSaving] = useState(false);
    const [activeTool, setActiveTool] = useState<ViewerTool | "display" | null>(null);
    const [isPlanMode, setIsPlanMode] = useState(false);
    const [selectedPlanLevelId, setSelectedPlanLevelId] = useState<string | null>(null);
    const [planRange, setPlanRange] = useState(planViewRange ?? { lower: 0, cut: 1.2, upper: 2.3 });
    const [planRangeInputs, setPlanRangeInputs] = useState(() => ({
        lower: String(Math.round((planViewRange?.lower ?? 0) * 1000)),
        cut: String(Math.round((planViewRange?.cut ?? 1.2) * 1000)),
        upper: String(Math.round((planViewRange?.upper ?? 2.3) * 1000)),
    }));
    const [activePanoramaStationId, setActivePanoramaStationId] = useState<string | null>(null);
    const [arePanoramaMarkersVisible, setArePanoramaMarkersVisible] = useState(true);
    const [panoramaMarkerLayouts, setPanoramaMarkerLayouts] = useState<PanoramaMarkerLayout[]>([]);
    const [isSelectionPanelVisible, setIsSelectionPanelVisible] = useState(true);
    const [loadedSceneVersion, setLoadedSceneVersion] = useState(0);
    const [filterPropertyKey, setFilterPropertyKey] = useState("");
    const [filterSelectedValues, setFilterSelectedValues] = useState<string[]>([]);
    const [filterValueSearch, setFilterValueSearch] = useState("");
    const [filterPropertySearch, setFilterPropertySearch] = useState("");
    const [filterValues, setFilterValues] = useState<FilterValue[]>([]);
    const [propertyViews, setPropertyViews] = useState<ProjectPropertyView[]>([]);
    const [propertyViewName, setPropertyViewName] = useState("");
    const [propertyViewError, setPropertyViewError] = useState("");
    const [isPropertyViewSaving, setIsPropertyViewSaving] = useState(false);
    const [activePropertyViewId, setActivePropertyViewId] = useState<string | null>(null);
    const [displayMode, setDisplayMode] = useState<DisplayMode>("shaded");
    const [displayOpacity, setDisplayOpacity] = useState(1);
    const [displayPropertyKey, setDisplayPropertyKey] = useState("");
    const [displaySelectedValues, setDisplaySelectedValues] = useState<string[]>([]);
    const [displayPropertySearch, setDisplayPropertySearch] = useState("");
    const [displayValueSearch, setDisplayValueSearch] = useState("");
    const [displayValues, setDisplayValues] = useState<FilterValue[]>([]);
    const [displayColor, setDisplayColor] = useState("#ff8a00");
    const [displayViewName, setDisplayViewName] = useState("");
    const [displayViews, setDisplayViews] = useState<ProjectDisplayView[]>([]);
    const [displayViewError, setDisplayViewError] = useState("");
    const [isDisplayViewSaving, setIsDisplayViewSaving] = useState(false);
    const [activeDisplayViewId, setActiveDisplayViewId] = useState<string | null>(null);
    const [packageVisibility, setPackageVisibility] = useState<Record<string, boolean>>(
        () => Object.fromEntries(
            scenePackageControls.map((scenePackage) => [scenePackage.id, true]),
        ),
    );
    const [visiblePropertyKeys, setVisiblePropertyKeys] = useState<string[] | null>(() => {
        const savedValue = window.localStorage.getItem(VISIBLE_PROPERTIES_STORAGE_KEY);
        return savedValue ? JSON.parse(savedValue) as string[] : null;
    });
    const activePanoramaStation = panoramaStations.find((station) => station.id === activePanoramaStationId) ?? null;
    const planLevels = useMemo(() => {
        if (!planReferenceModelId) return [];
        const referenceModel = modelPackages.find((model) => model.id === planReferenceModelId);
        const verticalOffset = referenceModel?.transform?.position?.[1] ?? 0;
        return (metadataByModelId[planReferenceModelId]?.levels ?? []).map((level) => ({
            ...level,
            // IFC storey elevation is in source-local coordinates; the XKT
            // model may be rebased by the same vertical offset as its geometry.
            elevation: level.elevation + verticalOffset,
        }));
    }, [metadataByModelId, modelPackages, planReferenceModelId]);

    useEffect(() => {
        void listProjectIssues(projectId)
            .then(setIssues)
            .catch((loadError: unknown) => setIssueError(
                loadError instanceof Error ? loadError.message : String(loadError),
            ));
    }, [projectId]);

    useEffect(() => {
        void listProjectPropertyViews(projectId)
            .then(setPropertyViews)
            .catch((loadError: unknown) => setPropertyViewError(
                loadError instanceof Error ? loadError.message : String(loadError),
            ));
    }, [projectId]);

    useEffect(() => {
        void listProjectDisplayViews(projectId)
            .then(setDisplayViews)
            .catch((loadError: unknown) => setDisplayViewError(
                loadError instanceof Error ? loadError.message : String(loadError),
            ));
    }, [projectId]);

    useEffect(() => {
        const metadataModels = modelPackages.filter(
            (model) => model.metadata?.format === "json",
        );
        void Promise.all(metadataModels.map(async (model) => ({
            modelId: model.id,
            metadata: await loadModelMetadata(model.metadata!.src),
        })))
            .then((loadedMetadata) => setMetadataByModelId(
                Object.fromEntries(loadedMetadata.map(({ modelId, metadata }) => [modelId, metadata])),
            ))
            .catch(() => setStatus("Model loaded, but metadata is unavailable"));
    }, [modelPackages]);

    const availableProperties = useMemo(() => {
        const properties = new Map<string, AvailableProperty>();
        Object.values(propertyDefinitionsByModelId).forEach((definitions) => {
            definitions.forEach((definition) => {
                properties.set(definition.propertyDefinitionId, {
                    key: definition.propertyDefinitionId,
                    propertySetName: definition.propertySetName,
                    propertyName: definition.displayName,
                });
            });
        });
        return [...properties.values()].sort((left, right) =>
            `${left.propertySetName} ${left.propertyName}`.localeCompare(
                `${right.propertySetName} ${right.propertyName}`,
            ));
    }, [propertyDefinitionsByModelId]);

    const loadPropertyDefinitionCatalogs = async () => {
        const missingModelIds = modelPackages
            .filter((model) => !catalogRequestedModelIdsRef.current.has(model.id))
            .map((model) => model.id);
        if (missingModelIds.length === 0) return;
        missingModelIds.forEach((modelId) => catalogRequestedModelIdsRef.current.add(modelId));
        setIsPropertyCatalogLoading(true);
        setPropertyCatalogError("");
        try {
            const catalogs = await Promise.all(missingModelIds.map(async (modelId) => ({
                modelId,
                definitions: await getPropertyDefinitionCatalog(projectId, modelId),
            })));
            setPropertyDefinitionsByModelId((current) => ({
                ...current,
                ...Object.fromEntries(catalogs.map(({ modelId, definitions }) => [modelId, definitions])),
            }));
        } catch (error) {
            missingModelIds.forEach((modelId) => catalogRequestedModelIdsRef.current.delete(modelId));
            setPropertyCatalogError(error instanceof Error ? error.message : String(error));
        } finally {
            setIsPropertyCatalogLoading(false);
        }
    };

    const openPropertyConfiguration = async () => {
        setIsPropertyConfigurationOpen(true);
        await loadPropertyDefinitionCatalogs();
    };

    useEffect(() => {
        if (visiblePropertyKeys !== null) {
            window.localStorage.setItem(
                VISIBLE_PROPERTIES_STORAGE_KEY,
                JSON.stringify(visiblePropertyKeys),
            );
        }
    }, [visiblePropertyKeys]);

    useEffect(() => {
        if (!canvasRef.current) {
            return;
        }

        const viewerService = new ViewerService();
        viewerServiceRef.current = viewerService;

        viewerService.initialize(canvasRef.current, modelPackages, effectivePointCloudPackages, {
            onModelLoaded: () => {
                setStatus("Model loaded");
                setLoadedSceneVersion((version) => version + 1);
            },
            onModelError: () => setStatus(
                "A model or point cloud could not be loaded. Check public/models.",
            ),
            onModelAreaExceeded: (limitMeters) => setStatus(
                `The model area exceeds the maximum limit, which is ${limitMeters / 1000}km.`,
            ),
            onSelectionChanged: (nextSelection) => {
                setSelection(nextSelection);
                setShowAllProperties(false);
                setPropertyRetrievalError("");
                if (!nextSelection) {
                    setElementActionContext(null);
                }
            },
            onElementActionContext: setElementActionContext,
            onCutPlaneCreated: () => {
                setIsCutMode(false);
                setCutCount((current) => current + 1);
                setCanFlipCut(true);
            },
            onDistanceMeasurementCreated: () => {
                setMeasurementCount((current) => current + 1);
            },
        });
        Object.entries(packageVisibilityRef.current).forEach(([packageId, visible]) => {
            viewerService.setPackageVisible(packageId, visible);
        });

        return () => {
            viewerService.destroy();
            viewerServiceRef.current = null;
        };
    }, [modelPackages, effectivePointCloudPackages, VIEWER_RUNTIME_REVISION]);

    useEffect(() => {
        const viewerService = viewerServiceRef.current;
        if (!viewerService || panoramaStations.length === 0 || !arePanoramaMarkersVisible) {
            setPanoramaMarkerLayouts([]);
            return;
        }
        viewerService.setPanoramaMarkers(panoramaStations, setPanoramaMarkerLayouts);
        return () => {
            viewerService.clearPanoramaMarkers();
            setPanoramaMarkerLayouts([]);
        };
    }, [panoramaStations, loadedSceneVersion, arePanoramaMarkersVisible]);

    // Persisting a View Range updates the project record, which intentionally
    // recreates the renderer with fresh scene packages. Return to the same
    // plan only after that renderer has loaded; otherwise the update leaves
    // the user in a perspective scene with Plan controls still open.
    useEffect(() => {
        const pending = pendingPlanRestoreRef.current;
        const viewerService = viewerServiceRef.current;
        if (!pending || !viewerService) return;
        const level = planLevels.find((candidate) => candidate.id === pending.levelId);
        if (!level) return;
        pointCloudPackages.forEach((pointCloud) => viewerService.setPackageVisible(pointCloud.id, false));
        if (!viewerService.enterPlanView(level.elevation, pending.range)) return;
        pendingPlanRestoreRef.current = null;
        setSelectedPlanLevelId(level.id);
        setIsPlanMode(true);
        setStatus(`Plan: ${level.name}`);
    }, [loadedSceneVersion, planLevels, pointCloudPackages]);

    useEffect(() => {
        const handleEscape = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            if (isDistanceMode) {
                viewerServiceRef.current?.setDistanceMeasurementMode(false);
                setIsDistanceMode(false);
                setStatus("Measuring stopped");
            }
            viewerServiceRef.current?.clearSelection();
            setSelection(null);
            setElementActionContext(null);
        };
        window.addEventListener("keydown", handleEscape);
        return () => window.removeEventListener("keydown", handleEscape);
    }, [isDistanceMode]);

    useEffect(() => {
        // A forced repaint keeps the WebGL canvas intact when an issue
        // overlay is mounted or removed above it.
        viewerServiceRef.current?.refreshScene();
    }, [issueDraft, isIssueManagerOpen]);

    const selectedMetadata = selection
        ? metadataByModelId[selection.modelId]
        : undefined;
    const selectedElement = selection
        ? selectedMetadata?.elements[selection.rendererObjectId]
        : undefined;
    const bootstrapSets = selectedElement
        ? bootstrapPropertySets(selectedElement, selectedMetadata)
        : [];
    const selectedRenderObjectId = selectedElement?.propertyStore?.renderObjectId;
    const effectiveVisiblePropertyKeys = normalizePropertyKeys(visiblePropertyKeys
        ?? getDefaultPropertyKeys(availableProperties), availableProperties);
    const selectedPropertyKeys = new Set(effectiveVisiblePropertyKeys);
    const needsConfiguredRetrieval = [...selectedPropertyKeys].some((key) => key.startsWith("canonical:"));
    const propertySets = (showAllProperties || needsConfiguredRetrieval)
        && selectedRenderObjectId
        && retrievedPropertyReference === `${selection?.modelId}:${selectedRenderObjectId}`
        && retrievedPropertySets
        ? retrievedPropertySets
        : bootstrapSets;
    const selectedProperties = propertySets.flatMap((propertySet) =>
        propertySet.properties
            .filter((property) => Boolean(selectedElement?.identity) || showAllProperties || selectedPropertyKeys.has(
                propertyDefinitionKey(propertySet, property),
            ))
            .map((property) => ({
                key: `${propertySet.id}:${property.name}`,
                filterKey: propertyDefinitionKey(propertySet, property),
                name: property.name,
                value: property.value,
                propertySetName: propertySet.name,
            })),
    );
    useEffect(() => {
        if (!selection || !selectedRenderObjectId || !needsConfiguredRetrieval || showAllProperties) return;
        const reference = `${selection.modelId}:${selectedRenderObjectId}`;
        if (retrievedPropertyReference === reference || propertyRetrievalRequestRefs.current.has(reference)) return;
        propertyRetrievalRequestRefs.current.add(reference);
        void Promise.resolve().then(async () => {
            setIsPropertyRetrievalLoading(true);
            setPropertyRetrievalError("");
            const response = await getPublishedElementProperties(projectId, selection.modelId, selectedRenderObjectId);
            setRetrievedPropertyReference(reference);
            setRetrievedPropertySets(response.propertySets);
        }).catch((error: unknown) => setPropertyRetrievalError(error instanceof Error ? error.message : String(error)))
            .finally(() => {
                propertyRetrievalRequestRefs.current.delete(reference);
                setIsPropertyRetrievalLoading(false);
            });
    }, [effectiveVisiblePropertyKeys, needsConfiguredRetrieval, projectId, retrievedPropertyReference, selectedRenderObjectId, selection, showAllProperties]);
    const toggleAllProperties = async () => {
        if (!selectedElement) return;
        if (showAllProperties) {
            setShowAllProperties(false);
            return;
        }
        const renderObjectId = selectedElement.propertyStore?.renderObjectId;
        if (!renderObjectId || !selection) {
            setPropertyRetrievalError("Full properties are not available for this model.");
            return;
        }
        const reference = `${selection.modelId}:${renderObjectId}`;
        if (retrievedPropertyReference === reference && retrievedPropertySets) {
            setShowAllProperties(true);
            return;
        }
        setIsPropertyRetrievalLoading(true);
        setPropertyRetrievalError("");
        try {
            const response = await getPublishedElementProperties(projectId, selection.modelId, renderObjectId);
            setRetrievedPropertyReference(reference);
            setRetrievedPropertySets(response.propertySets);
            setShowAllProperties(true);
        } catch (error) {
            setPropertyRetrievalError(error instanceof Error ? error.message : String(error));
        } finally {
            setIsPropertyRetrievalLoading(false);
        }
    };
    const filteredAvailableProperties = availableProperties.filter((property) =>
        `${property.propertySetName} ${property.propertyName}`
            .toLocaleLowerCase()
            .includes(propertySearch.toLocaleLowerCase()),
    );
    const matchingFilterProperties = availableProperties.filter((property) =>
        `${property.propertySetName} ${property.propertyName}`
            .toLocaleLowerCase()
            .includes(filterPropertySearch.toLocaleLowerCase()),
    );
    const defaultFilterProperties = matchingFilterProperties.filter((property) =>
        property.propertyName.trim().toLocaleLowerCase() === "category",
    );
    const additionalFilterProperties = matchingFilterProperties.filter((property) =>
        property.propertyName.trim().toLocaleLowerCase() !== "category",
    );
    const canonicalFilterPropertyKey = normalizePropertyKey(filterPropertyKey, availableProperties);
    useEffect(() => {
        if (!canonicalFilterPropertyKey) { void Promise.resolve().then(() => setFilterValues([])); return; }
        let cancelled = false;
        void Promise.all(modelPackages.map(async (model) => ({
            modelId: model.id,
            values: await getCanonicalPropertyValues(projectId, model.id, canonicalFilterPropertyKey).catch(() => []),
        }))).then((results) => {
            if (cancelled) return;
            setFilterValues(results.flatMap(({ modelId, values }) => values.map((value) => ({
                id: encodeModelValueId(modelId, value.valueId), value: value.displayValue, count: value.count,
            }))).sort((left, right) => left.value.localeCompare(right.value, undefined, { numeric: true })));
        });
        return () => { cancelled = true; };
    }, [canonicalFilterPropertyKey, modelPackages, projectId]);
    const visibleFilterValues = filterValues.filter(({ value }) =>
        value.toLocaleLowerCase().includes(filterValueSearch.toLocaleLowerCase()),
    );
    const hasActivePropertyFilter = Boolean(filterPropertyKey && filterSelectedValues.length > 0);
    const canonicalDisplayPropertyKey = normalizePropertyKey(displayPropertyKey, availableProperties);
    useEffect(() => {
        if (!canonicalDisplayPropertyKey) { void Promise.resolve().then(() => setDisplayValues([])); return; }
        let cancelled = false;
        void Promise.all(modelPackages.map(async (model) => ({
            modelId: model.id,
            values: await getCanonicalPropertyValues(projectId, model.id, canonicalDisplayPropertyKey).catch(() => []),
        }))).then((results) => {
            if (cancelled) return;
            setDisplayValues(results.flatMap(({ modelId, values }) => values.map((value) => ({
                id: encodeModelValueId(modelId, value.valueId), value: value.displayValue, count: value.count,
            }))).sort((left, right) => left.value.localeCompare(right.value, undefined, { numeric: true })));
        });
        return () => { cancelled = true; };
    }, [canonicalDisplayPropertyKey, modelPackages, projectId]);
    const matchingDisplayProperties = availableProperties.filter((property) =>
        `${property.propertySetName} ${property.propertyName}`
            .toLocaleLowerCase()
            .includes(displayPropertySearch.toLocaleLowerCase()),
    );
    const visibleDisplayValues = displayValues.filter(({ value }) =>
        value.toLocaleLowerCase().includes(displayValueSearch.toLocaleLowerCase()),
    );

    useEffect(() => {
        const viewerService = viewerServiceRef.current;
        if (!viewerService) return;
        viewerService.setDisplayMode(displayMode, displayOpacity);
        if (!canonicalDisplayPropertyKey || displaySelectedValues.length === 0) {
            viewerService.setColorOverride([], undefined);
            return;
        }
        let cancelled = false;
        const valuesByModel = new Map<string, string[]>();
        displaySelectedValues.flatMap((selected) => {
            const decoded = decodeModelValueId(selected);
            return decoded ? [decoded] : displayValues.filter((value) => value.value === selected).map((value) => decodeModelValueId(value.id)!);
        }).forEach((decoded) => {
            valuesByModel.set(decoded.modelId, [...(valuesByModel.get(decoded.modelId) ?? []), decoded.valueId]);
        });
        void Promise.all(modelPackages.map(async (model) => ({
            modelId: model.id,
            matches: await getCanonicalPropertyMatches(projectId, model.id, canonicalDisplayPropertyKey, valuesByModel.get(model.id) ?? []).catch(() => ({ rendererObjectIds: [] })),
        }))).then((results) => {
            if (cancelled) return;
            const matchedObjectIds = results.flatMap(({ modelId, matches }) => matches.rendererObjectIds.map((id) => `${modelId}#${id}`));
            viewerService.setColorOverride(matchedObjectIds, matchedObjectIds.length > 0 ? hexToRgb(displayColor) : undefined);
        });
        return () => { cancelled = true; };
    }, [displayMode, displayOpacity, canonicalDisplayPropertyKey, displaySelectedValues, displayValues, displayColor, modelPackages, projectId, loadedSceneVersion]);

    useEffect(() => {
        const viewerService = viewerServiceRef.current;
        if (!viewerService) return;
        if (!canonicalFilterPropertyKey) {
            viewerService.clearPropertyFilter();
            return;
        }
        let cancelled = false;
        const valuesByModel = new Map<string, string[]>();
        filterSelectedValues.flatMap((selected) => {
            const decoded = decodeModelValueId(selected);
            return decoded ? [decoded] : filterValues.filter((value) => value.value === selected).map((value) => decodeModelValueId(value.id)!);
        }).forEach((decoded) => {
            valuesByModel.set(decoded.modelId, [...(valuesByModel.get(decoded.modelId) ?? []), decoded.valueId]);
        });
        void Promise.all(modelPackages.map(async (model) => ({
            modelId: model.id,
            matches: await getCanonicalPropertyMatches(projectId, model.id, canonicalFilterPropertyKey, valuesByModel.get(model.id) ?? []).catch(() => ({ rendererObjectIds: [] })),
        }))).then((results) => {
            if (cancelled) return;
            viewerService.setPropertyFilter(Object.fromEntries(results.map(({ modelId, matches }) => [modelId, matches.rendererObjectIds])));
        });
        return () => { cancelled = true; };
    }, [canonicalFilterPropertyKey, filterSelectedValues, filterValues, modelPackages, projectId, loadedSceneVersion]);
    const filteredIssues = useMemo(() => {
        const search = issueSearch.trim().toLocaleLowerCase();
        return issues
            .filter((issue) => issueStatusFilter === "all" || issue.status === issueStatusFilter)
            .filter((issue) => issueCategoryFilter === "all" || issue.category === issueCategoryFilter)
            .filter((issue) => !search || `${issue.title} ${issue.description}`
                .toLocaleLowerCase()
                .includes(search))
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    }, [issues, issueSearch, issueStatusFilter, issueCategoryFilter]);
    const selectedIssue = filteredIssues.find((issue) => issue.id === selectedIssueId) ?? null;
    const issueCategories = useMemo(() => [...new Set(issues
        .map((issue) => issue.category)
        .filter((category): category is string => Boolean(category)))].sort((left, right) => left.localeCompare(right)), [issues]);

    const toggleVisibleProperty = (propertyKey: string) => {
        setVisiblePropertyKeys((previous) => {
            const current = new Set(previous ?? effectiveVisiblePropertyKeys);
            if (current.has(propertyKey)) {
                current.delete(propertyKey);
            } else {
                current.add(propertyKey);
            }
            return [...current];
        });
    };

    const toggleCutMode = () => {
        const nextCutMode = !isCutMode;
        if (nextCutMode) {
            viewerServiceRef.current?.setDistanceMeasurementMode(false);
            viewerServiceRef.current?.stopEditingDistanceMeasurement();
            setIsDistanceMode(false);
            setIsEditingMeasurement(false);
        }
        viewerServiceRef.current?.setCutMode(nextCutMode);
        setIsCutMode(nextCutMode);
        setActiveTool("section");
    };

    const clearCuts = () => {
        viewerServiceRef.current?.clearSectionPlanes();
        setIsCutMode(false);
        setCutCount(0);
        setCanFlipCut(false);
    };

    const toggleDistanceMode = () => {
        const nextDistanceMode = !isDistanceMode;
        if (nextDistanceMode) {
            viewerServiceRef.current?.setCutMode(false);
            setIsCutMode(false);
            setIsEditingMeasurement(false);
        }
        viewerServiceRef.current?.setDistanceMeasurementMode(nextDistanceMode);
        setIsDistanceMode(nextDistanceMode);
        setActiveTool("measure");
    };

    const toggleMeasurementEditing = () => {
        if (isEditingMeasurement) {
            viewerServiceRef.current?.stopEditingDistanceMeasurement();
            setIsEditingMeasurement(false);
            return;
        }
        setIsDistanceMode(false);
        const editingStarted = viewerServiceRef.current
            ?.startEditingLatestDistanceMeasurement() ?? false;
        setIsEditingMeasurement(editingStarted);
    };

    const clearMeasurements = () => {
        viewerServiceRef.current?.clearDistanceMeasurements();
        setIsDistanceMode(false);
        setIsEditingMeasurement(false);
        setMeasurementCount(0);
    };

    const hideSelectedElement = () => {
        if (!elementActionContext) return;
        viewerServiceRef.current?.hideElement(elementActionContext.selection);
        setSelection(null);
        setElementActionContext(null);
        setStatus("Element hidden");
    };

    const isolateSelectedElement = () => {
        if (!elementActionContext) return;
        viewerServiceRef.current?.isolateElement(elementActionContext.selection);
        setElementActionContext(null);
        setStatus("Element isolated");
    };

    const sectionSelectedSurface = () => {
        if (!elementActionContext?.worldPos) return;
        const sectionCreated = viewerServiceRef.current?.createSectionAt(
            elementActionContext.worldPos,
            elementActionContext.worldNormal,
        );
        if (sectionCreated) {
            setIsCutMode(false);
            setCutCount((current) => current + 1);
            setCanFlipCut(true);
            setStatus("Section plane created");
        }
        setElementActionContext(null);
    };

    const showAllElements = () => {
        viewerServiceRef.current?.showAllElements();
        setElementActionContext(null);
        setStatus("All IFC elements shown");
    };

    const setPackageVisible = (packageId: string, visible: boolean) => {
        viewerServiceRef.current?.setPackageVisible(packageId, visible);
        packageVisibilityRef.current = {
            ...packageVisibilityRef.current,
            [packageId]: visible,
        };
        setPackageVisibility((previous) => ({
            ...previous,
            [packageId]: visible,
        }));
    };

    const isolatePackage = (packageId: string) => {
        viewerServiceRef.current?.isolatePackage(packageId);
        const nextVisibility = Object.fromEntries(
            scenePackageControls.map((scenePackage) => [scenePackage.id, scenePackage.id === packageId]),
        );
        packageVisibilityRef.current = nextVisibility;
        setPackageVisibility(nextVisibility);
        setStatus("Showing isolated file");
    };

    const setPointCloudDetail = (pointCloudId: string, pointStride: number) => {
        setStatus("Reloading point cloud detail...");
        setPointCloudStrides((current) => ({ ...current, [pointCloudId]: pointStride }));
    };

    const toggleFilterValue = (value: string) => {
        setFilterSelectedValues((current) => current.includes(value)
            ? current.filter((candidate) => candidate !== value)
            : [...current, value]);
    };

    const filterBySelectedProperty = async (property: {
        filterKey: string;
        value: unknown;
    }) => {
        if (!selection) return;
        const values = await getCanonicalPropertyValues(projectId, selection.modelId, property.filterKey);
        const match = values.find((entry) => entry.displayValue === String(property.value));
        if (!match) {
            setStatus("This property value is not available for filtering.");
            return;
        }
        setFilterPropertyKey(property.filterKey);
        setFilterSelectedValues([encodeModelValueId(selection.modelId, match.valueId)]);
        setFilterPropertySearch("");
        setFilterValueSearch("");
        setStatus("Property filter applied");
    };

    const toggleDisplayValue = (value: string) => {
        setDisplaySelectedValues((current) => current.includes(value)
            ? current.filter((candidate) => candidate !== value)
            : [...current, value]);
    };

    const saveDisplayView = async () => {
        if (!displayViewName.trim()) return;
        setIsDisplayViewSaving(true);
        setDisplayViewError("");
        try {
            const view = await createProjectDisplayView(projectId, {
                name: displayViewName.trim(),
                mode: displayMode,
                opacity: displayOpacity,
                ...(canonicalDisplayPropertyKey && displaySelectedValues.length > 0 ? {
                    colorOverride: {
                        propertyKey: canonicalDisplayPropertyKey,
                        values: displaySelectedValues,
                        color: displayColor,
                    },
                } : {}),
            });
            setDisplayViews((current) => [...current, view]);
            setDisplayViewName("");
        } catch (saveError) {
            setDisplayViewError(saveError instanceof Error ? saveError.message : String(saveError));
        } finally {
            setIsDisplayViewSaving(false);
        }
    };

    const applyDisplayView = (view: ProjectDisplayView) => {
        setDisplayMode(view.mode);
        setDisplayOpacity(view.opacity);
        setDisplayPropertyKey(normalizePropertyKey(view.colorOverride?.propertyKey ?? "", availableProperties));
        setDisplaySelectedValues(view.colorOverride?.values ?? []);
        setDisplayColor(view.colorOverride?.color ?? "#ff8a00");
        setDisplayValueSearch("");
    };

    const changeDisplayMode = (nextMode: DisplayMode) => {
        setDisplayMode(nextMode);
        setDisplayOpacity(nextMode === "xray" ? 0.3 : 1);
    };

    const removeDisplayView = async (view: ProjectDisplayView) => {
        setActiveDisplayViewId(view.id);
        setDisplayViewError("");
        try {
            await deleteProjectDisplayView(projectId, view.id);
            setDisplayViews((current) => current.filter((candidate) => candidate.id !== view.id));
        } catch (deleteError) {
            setDisplayViewError(deleteError instanceof Error ? deleteError.message : String(deleteError));
        } finally {
            setActiveDisplayViewId(null);
        }
    };

    const savePropertyView = async () => {
        if (!propertyViewName.trim()) return;
        setIsPropertyViewSaving(true);
        setPropertyViewError("");
        try {
            const view = await createProjectPropertyView(
                projectId,
                propertyViewName.trim(),
                effectiveVisiblePropertyKeys,
            );
            setPropertyViews((current) => [...current, view]);
            setPropertyViewName("");
        } catch (saveError) {
            setPropertyViewError(saveError instanceof Error ? saveError.message : String(saveError));
        } finally {
            setIsPropertyViewSaving(false);
        }
    };

    const removePropertyView = async (view: ProjectPropertyView) => {
        setActivePropertyViewId(view.id);
        setPropertyViewError("");
        try {
            await deleteProjectPropertyView(projectId, view.id);
            setPropertyViews((current) => current.filter((candidate) => candidate.id !== view.id));
        } catch (deleteError) {
            setPropertyViewError(deleteError instanceof Error ? deleteError.message : String(deleteError));
        } finally {
            setActivePropertyViewId(null);
        }
    };

    const toggleToolbarTool = (tool: ViewerTool | "properties") => {
        if (tool === "properties") {
            setIsSelectionPanelVisible((visible) => !visible);
            return;
        }
        if (tool === "filter" || tool === "display") void loadPropertyDefinitionCatalogs();
        setActiveTool((current) => current === tool ? null : tool);
    };

    const zoomAll = () => {
        viewerServiceRef.current?.zoomAll();
        setStatus("View reset");
    };

    const openPlanLevel = (levelId: string) => {
        const level = planLevels.find((candidate) => candidate.id === levelId);
        if (!level) return;
        pointCloudPackages.forEach((pointCloud) => viewerServiceRef.current?.setPackageVisible(pointCloud.id, false));
        const entered = viewerServiceRef.current?.enterPlanView(level.elevation, planRange) ?? false;
        if (entered) {
            setSelectedPlanLevelId(levelId);
            setIsPlanMode(true);
            setStatus(`Plan: ${level.name}`);
        }
    };

    const closePlanView = () => {
        viewerServiceRef.current?.exitPlanView();
        pointCloudPackages.forEach((pointCloud) => viewerServiceRef.current?.setPackageVisible(
            pointCloud.id,
            packageVisibilityRef.current[pointCloud.id] ?? true,
        ));
        setIsPlanMode(false);
        setStatus("3D view");
    };

    const reloadPlanView = () => {
        const next = {
            lower: Number(planRangeInputs.lower) / 1000,
            cut: Number(planRangeInputs.cut) / 1000,
            upper: Number(planRangeInputs.upper) / 1000,
        };
        if (!Number.isFinite(next.lower) || !Number.isFinite(next.cut) || !Number.isFinite(next.upper) || next.lower > next.cut || next.cut > next.upper) {
            setStatus("Plan range must satisfy Lower ≤ Cut ≤ Upper");
            return;
        }
        setPlanRange(next);
        onPlanViewRangeChange?.(next);
        if (!isPlanMode || !selectedPlanLevelId) return;
        const level = planLevels.find((candidate) => candidate.id === selectedPlanLevelId);
        if (!level) return;
        pointCloudPackages.forEach((pointCloud) => viewerServiceRef.current?.setPackageVisible(pointCloud.id, false));
        if (viewerServiceRef.current?.enterPlanView(level.elevation, next)) {
            pendingPlanRestoreRef.current = null;
            setStatus(`Plan: ${level.name}`);
        }
    };

    const startIssueCreation = () => {
        try {
            const capturedView = viewerServiceRef.current?.captureIssueView();
            if (!capturedView) {
                return;
            }
            setIssueDraft({
                ...capturedView,
                ...(selection ? {
                    selection: {
                        ...selection,
                        globalId: selectedElement?.globalId,
                        type: selectedElement?.type,
                        name: selectedElement?.name,
                    },
                } : {}),
            });
            setIssueTitle("");
            setIssueDescription("");
            setIssueCategory("");
            setIssueError("");
            // Snapshot capture temporarily touches the WebGL drawing buffer.
            // Repaint before the dialog's backdrop covers the canvas.
            viewerServiceRef.current?.refreshScene();
        } catch (captureError) {
            setIssueError(
                captureError instanceof Error ? captureError.message : String(captureError),
            );
        }
    };

    const saveIssue = async () => {
        if (!issueDraft || !issueTitle.trim()) {
            return;
        }
        setIsIssueSaving(true);
        setIssueError("");
        try {
            const issue = await createProjectIssue(projectId, {
                title: issueTitle.trim(),
                description: issueDescription.trim(),
                category: issueCategory.trim(),
                screenshotData: issueDraft.screenshotData,
                viewpoint: issueDraft.viewpoint,
                packageVisibility,
                selection: issueDraft.selection,
            });
            setIssues((current) => [issue, ...current]);
            setIssueDraft(null);
            setStatus("Issue saved");
        } catch (saveError) {
            setIssueError(saveError instanceof Error ? saveError.message : String(saveError));
        } finally {
            setIsIssueSaving(false);
        }
    };

    const openIssue = (issue: ProjectIssue) => {
        const restoredVisibility = Object.fromEntries(
            scenePackageControls.map((scenePackage) => [
                scenePackage.id,
                issue.packageVisibility[scenePackage.id] ?? true,
            ]),
        );
        const restoredCutCount = viewerServiceRef.current?.restoreIssueView(
            issue.viewpoint,
            restoredVisibility,
        ) ?? 0;
        setPackageVisibility(restoredVisibility);
        setSelection(null);
        setIsCutMode(false);
        setCutCount(restoredCutCount);
        setCanFlipCut(false);
        setIsDistanceMode(false);
        setIsEditingMeasurement(false);
        setStatus(`Opened issue: ${issue.title}`);
    };

    const openIssueManager = (issue?: ProjectIssue) => {
        setSelectedIssueId(issue?.id ?? selectedIssueId ?? issues[0]?.id ?? null);
        setIssueError("");
        setIsIssueManagerOpen(true);
    };

    const replaceIssue = (updatedIssue: ProjectIssue) => {
        setIssues((current) => current.map((candidate) =>
            candidate.id === updatedIssue.id ? updatedIssue : candidate,
        ));
    };

    const changeIssueStatus = async (issue: ProjectIssue, status: ProjectIssue["status"]) => {
        setIsIssueStatusUpdating(true);
        setIssueError("");
        try {
            const updatedIssue = await updateProjectIssueStatus(projectId, issue.id, status);
            replaceIssue(updatedIssue);
        } catch (updateError) {
            setIssueError(updateError instanceof Error ? updateError.message : String(updateError));
        } finally {
            setIsIssueStatusUpdating(false);
        }
    };

    const startIssueEditing = (issue: ProjectIssue) => {
        setEditIssueTitle(issue.title);
        setEditIssueDescription(issue.description);
        setEditIssueCategory(issue.category ?? "");
        setIsIssueEditing(true);
        setIssueError("");
    };

    const saveIssueEdits = async (issue: ProjectIssue) => {
        if (!editIssueTitle.trim()) return;
        setIsIssueStatusUpdating(true);
        setIssueError("");
        try {
            const updatedIssue = await updateProjectIssue(projectId, issue.id, {
                title: editIssueTitle.trim(),
                description: editIssueDescription.trim(),
                category: editIssueCategory.trim(),
            });
            replaceIssue(updatedIssue);
            setIsIssueEditing(false);
        } catch (updateError) {
            setIssueError(updateError instanceof Error ? updateError.message : String(updateError));
        } finally {
            setIsIssueStatusUpdating(false);
        }
    };

    const saveIssueComment = async (issue: ProjectIssue) => {
        if (!commentAuthorName.trim() || !commentBody.trim()) return;
        setIsCommentSaving(true);
        setIssueError("");
        try {
            const updatedIssue = await addProjectIssueComment(projectId, issue.id, {
                authorName: commentAuthorName.trim(),
                body: commentBody.trim(),
            });
            replaceIssue(updatedIssue);
            setCommentBody("");
        } catch (commentError) {
            setIssueError(commentError instanceof Error ? commentError.message : String(commentError));
        } finally {
            setIsCommentSaving(false);
        }
    };

    return (
        <main className="viewer-shell">
            <canvas
                ref={canvasRef}
                className="viewer-canvas"
                onPointerDown={() => setActiveTool(null)}
            />
            {!isPlanMode && elementActionContext && (
                <section
                    className="element-action-menu"
                    aria-label="Selected element actions"
                    style={{
                        left: Math.max(8, Math.min(
                            elementActionContext.canvasPos[0] + 12,
                            window.innerWidth - 268,
                        )),
                        top: Math.max(8, Math.min(
                            elementActionContext.canvasPos[1] + 12,
                            window.innerHeight - 126,
                        )),
                    }}
                >
                    <button type="button" onClick={hideSelectedElement}>Hide</button>
                    <button type="button" onClick={isolateSelectedElement}>Isolate</button>
                    <button
                        type="button"
                        disabled={!elementActionContext.worldPos}
                        onClick={sectionSelectedSurface}
                    >
                        Section
                    </button>
                    <button type="button" className="element-action-show-all" onClick={showAllElements}>
                        Show all
                    </button>
                </section>
            )}
            <div className="panorama-marker-layer" aria-hidden={!arePanoramaMarkersVisible}>
            {arePanoramaMarkersVisible && panoramaMarkerLayouts.map((marker) => {
                const station = panoramaStations.find((candidate) => candidate.id === marker.id);
                if (!station || !marker.visible) return null;
                const activeLevel = planLevels.find((level) => level.id === selectedPlanLevelId);
                // Scanner stations have no native building level. Compare their
                // tripod height to the nearest reference floor (+1.5 m).
                const belongsToActivePlan = !isPlanMode || !activeLevel || planLevels.reduce((closest, candidate) =>
                    Math.abs(candidate.elevation + 1.5 - station.position[1]) < Math.abs(closest.elevation + 1.5 - station.position[1]) ? candidate : closest,
                planLevels[0]!).id === activeLevel.id;
                if (!belongsToActivePlan) return null;
                return (
                    <button
                        key={marker.id}
                        type="button"
                        className="panorama-scene-marker"
                        style={{ left: marker.canvasPos[0], top: marker.canvasPos[1] }}
                        aria-label={`Open panorama: ${station.name}`}
                        onClick={() => setActivePanoramaStationId(station.id)}
                    />
                );
            })}
            </div>
            <nav className="viewer-toolbar" aria-label="Scene tools">
                {([
                    ["view", "Zoom all"],
                    ["display", "Display"],
                    ["section", "Section cut"],
                    ["measure", "Measure"],
                    ["scene", "Scene"],
                    ["plan", "Plan"],
                    ["filter", "Filter by property"],
                    ["properties", "Properties"],
                ] as const).map(([tool, label]) => {
                    const hasPersistentToolState = (tool === "section" && cutCount > 0)
                        || (tool === "measure" && measurementCount > 0)
                        || (tool === "filter" && hasActivePropertyFilter);
                    const isActive = tool === "properties"
                        ? isSelectionPanelVisible
                        : tool === "view"
                            ? false
                            : activeTool === tool || hasPersistentToolState;
                    const toolLabel = tool === "filter" && hasActivePropertyFilter
                        ? "Filter by property (active)"
                        : tool === "section" && cutCount > 0
                            ? "Section cut (active)"
                            : tool === "measure" && measurementCount > 0
                                ? "Measure (active)"
                                : label;
                    const iconName = tool === "filter" && hasActivePropertyFilter
                        ? "filter-active"
                        : tool === "section" && cutCount > 0
                            ? "section-active"
                            : tool === "measure" && measurementCount > 0
                                ? "measure-active"
                                : tool;
                    return (
                        <button
                            key={tool}
                            type="button"
                            className={isActive ? "viewer-toolbar-button is-active" : "viewer-toolbar-button"}
                            aria-label={toolLabel}
                            aria-pressed={isActive}
                            title={toolLabel}
                            onClick={() => tool === "view" ? zoomAll() : toggleToolbarTool(tool)}
                        >
                            <ToolIcon name={iconName} />
                        </button>
                    );
                })}
            </nav>
            {activeTool && (
                <section className="viewer-tool-drawer" aria-label={`${activeTool} options`}>
                    {activeTool === "display" && (
                        <>
                            <h2>Display</h2>
                            <label className="property-filter-field">
                                View mode
                                <select value={displayMode} onChange={(event) => changeDisplayMode(event.target.value as DisplayMode)}>
                                    <option value="shaded">Shaded</option>
                                    <option value="xray">X-Ray</option>
                                </select>
                            </label>
                            <label className="property-filter-field">
                                IFC opacity: {Math.round(displayOpacity * 100)}%
                                <input
                                    type="range"
                                    min="0"
                                    max="100"
                                    value={Math.round(displayOpacity * 100)}
                                    onChange={(event) => setDisplayOpacity(Number(event.target.value) / 100)}
                                />
                            </label>
                            <div className="display-override-heading">
                                <strong>Color override</strong>
                                <input
                                    type="color"
                                    aria-label="Override color"
                                    value={displayColor}
                                    onChange={(event) => setDisplayColor(event.target.value)}
                                />
                            </div>
                            <label className="property-filter-field">
                                Search property
                                <input
                                    type="search"
                                    placeholder="Search parameters"
                                    value={displayPropertySearch}
                                    onChange={(event) => setDisplayPropertySearch(event.target.value)}
                                />
                            </label>
                            <label className="property-filter-field">
                                Property
                                <select
                                    value={displayPropertyKey}
                                    onChange={(event) => {
                                        setDisplayPropertyKey(event.target.value);
                                        setDisplaySelectedValues([]);
                                        setDisplayValueSearch("");
                                    }}
                                >
                                    <option value="">No color override</option>
                                    {matchingDisplayProperties.map((property) => (
                                        <option key={property.key} value={property.key}>
                                            {property.propertyName} — {property.propertySetName}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            {displayPropertyKey && <>
                                <input
                                    className="property-filter-search"
                                    type="search"
                                    placeholder="Search values"
                                    value={displayValueSearch}
                                    onChange={(event) => setDisplayValueSearch(event.target.value)}
                                />
                                <div className="property-filter-actions">
                                    <button type="button" onClick={() => setDisplaySelectedValues(displayValues.map(({ id }) => id))}>Select all</button>
                                    <button type="button" onClick={() => setDisplaySelectedValues([])}>Clear</button>
                                </div>
                                <div className="property-filter-values">
                                    {visibleDisplayValues.map(({ id, value, count }) => (
                                        <label key={id} className="property-filter-value">
                                            <input type="checkbox" checked={displaySelectedValues.includes(id)} onChange={() => toggleDisplayValue(id)} />
                                            <span>{value}</span><small>{count}</small>
                                        </label>
                                    ))}
                                </div>
                            </>}
                            <div className="property-view-save-row">
                                <input type="text" placeholder="Display view name" value={displayViewName} onChange={(event) => setDisplayViewName(event.target.value)} />
                                <button type="button" disabled={isDisplayViewSaving || !displayViewName.trim()} onClick={() => void saveDisplayView()}>
                                    {isDisplayViewSaving ? "Saving..." : "Save view"}
                                </button>
                            </div>
                            {displayViewError && <p className="property-view-error">{displayViewError}</p>}
                            {displayViews.length > 0 && <div className="property-view-list">
                                {displayViews.map((view) => (
                                    <div key={view.id} className="property-view-item">
                                        <strong>{view.name}</strong>
                                        <span>{view.mode}{view.colorOverride ? " + color" : ""}</span>
                                        <button type="button" onClick={() => applyDisplayView(view)}>Apply</button>
                                        <button type="button" disabled={activeDisplayViewId === view.id} onClick={() => void removeDisplayView(view)}>Delete</button>
                                    </div>
                                ))}
                            </div>}
                        </>
                    )}
                    {activeTool === "section" && (
                        <>
                            <h2>Section cut</h2>
                            <button
                                type="button"
                                className={isCutMode ? "cut-button is-active" : "cut-button"}
                                onClick={toggleCutMode}
                            >
                                {isCutMode ? "Cancel cut" : "Cut surface"}
                            </button>
                            {isCutMode && <p>Click a model surface to create a cut.</p>}
                            <div className="cut-actions">
                                <button
                                    type="button"
                                    disabled={cutCount === 0 || !canFlipCut}
                                    onClick={() => viewerServiceRef.current?.flipActiveSectionPlane()}
                                >
                                    Flip cut
                                </button>
                                <button type="button" disabled={cutCount === 0} onClick={clearCuts}>
                                    Clear cuts{cutCount > 0 ? ` (${cutCount})` : ""}
                                </button>
                            </div>
                        </>
                    )}
                    {activeTool === "measure" && (
                        <>
                            <h2>Measure</h2>
                            <button
                                type="button"
                                className={isDistanceMode ? "measure-button is-active" : "measure-button"}
                                onClick={toggleDistanceMode}
                            >
                                {isDistanceMode ? "Stop measuring" : "Distance"}
                            </button>
                            {isDistanceMode && <p>Click two points. X, Y, Z and total distance are shown.</p>}
                            <div className="measurement-actions">
                                <button
                                    type="button"
                                    disabled={measurementCount === 0}
                                    onClick={toggleMeasurementEditing}
                                >
                                    {isEditingMeasurement ? "Done editing" : "Edit last"}
                                </button>
                                <button
                                    type="button"
                                    disabled={measurementCount === 0}
                                    onClick={clearMeasurements}
                                >
                                    Clear{measurementCount > 0 ? ` (${measurementCount})` : ""}
                                </button>
                            </div>
                        </>
                    )}
                    {activeTool === "scene" && (
                        <>
                            <h2>Scene</h2>
                            {scenePackageControls.map((scenePackage) => (
                                <div key={scenePackage.id} className="scene-package-entry">
                                    <label className="scene-package-toggle">
                                        <input
                                            type="checkbox"
                                            checked={packageVisibility[scenePackage.id] ?? true}
                                            onChange={(event) => setPackageVisible(
                                                scenePackage.id,
                                                event.target.checked,
                                            )}
                                        />
                                        <span>
                                            <strong>{scenePackage.displayName}</strong>
                                        </span>
                                    </label>
                                    <button
                                        type="button"
                                        className="scene-package-isolate"
                                        onClick={() => isolatePackage(scenePackage.id)}
                                        title={`Show only ${scenePackage.displayName}`}
                                    >
                                        Isolate
                                    </button>
                                    {scenePackage.kind === "Point cloud" && (
                                        <label className="point-detail-control">
                                            Detail
                                            <select
                                                value={pointCloudStrides[scenePackage.id] ?? 50}
                                                onChange={(event) => setPointCloudDetail(scenePackage.id, Number(event.target.value))}
                                            >
                                                {showBalancedPointCloudDetail && <option value="10">Balanced</option>}
                                                <option value="50">Fast</option>
                                                <option value="80">Very fast</option>
                                            </select>
                                        </label>
                                    )}
                                </div>
                            ))}
                            {panoramaStations.length > 0 && (
                                <label className="scene-panorama-toggle">
                                    <input
                                        type="checkbox"
                                        checked={arePanoramaMarkersVisible}
                                        onChange={(event) => setArePanoramaMarkersVisible(event.target.checked)}
                                    />
                                    Panorama markers
                                </label>
                            )}
                        </>
                    )}
                    {activeTool === "plan" && (
                        <>
                            <h2>Plan</h2>
                            {!planReferenceModelId && <p>Select an IFC as plan reference on the project page.</p>}
                            {planReferenceModelId && planLevels.length === 0 && <p>The reference IFC does not contain usable IfcBuildingStorey elevations yet. Reprocess it after this update.</p>}
                            <div className="plan-level-buttons">{planLevels.map((level) => <button key={level.id} type="button" className={selectedPlanLevelId === level.id && isPlanMode ? "cut-button is-active" : "cut-button"} onClick={() => openPlanLevel(level.id)}>{level.name}</button>)}</div>
                            {isPlanMode && <button type="button" className="cut-button" onClick={closePlanView}>Back to 3D</button>}
                            {planReferenceModelId && <div className="plan-range-controls">
                                {(["lower", "cut", "upper"] as const).map((key) => <label key={key}>{key === "lower" ? "Lower" : key === "cut" ? "Cut" : "Upper"} (mm)<input type="text" inputMode="numeric" value={planRangeInputs[key]} onChange={(event) => setPlanRangeInputs((current) => ({ ...current, [key]: event.target.value }))} /></label>)}
                                <button type="button" onClick={reloadPlanView}>Reload plan view</button>
                            </div>}
                        </>
                    )}
                    {activeTool === "filter" && (
                        <>
                            <h2>Filter by property</h2>
                            <label className="property-filter-field">
                                Search properties
                                <input
                                    className="property-filter-search"
                                    type="search"
                                    placeholder="Search parameters"
                                    value={filterPropertySearch}
                                    onChange={(event) => setFilterPropertySearch(event.target.value)}
                                />
                            </label>
                            <label className="property-filter-field">
                                Property
                                <select
                                    value={filterPropertyKey}
                                    onChange={(event) => {
                                        setFilterPropertyKey(event.target.value);
                                        setFilterSelectedValues([]);
                                        setFilterValueSearch("");
                                    }}
                                >
                                    <option value="">No active filter</option>
                                    {defaultFilterProperties.length > 0 && (
                                        <optgroup label="Default parameters">
                                            {defaultFilterProperties.map((property) => (
                                                <option key={property.key} value={property.key}>
                                                    {property.propertyName} — {property.propertySetName}
                                                </option>
                                            ))}
                                        </optgroup>
                                    )}
                                    {additionalFilterProperties.length > 0 && (
                                        <optgroup label="All parameters">
                                            {additionalFilterProperties.map((property) => (
                                                <option key={property.key} value={property.key}>
                                                    {property.propertyName} — {property.propertySetName}
                                                </option>
                                            ))}
                                        </optgroup>
                                    )}
                                </select>
                            </label>
                            {filterPropertyKey && (
                                <>
                                    <p className="property-filter-note">
                                        Select values to show matching elements. Elements without this property are hidden.
                                    </p>
                                    <input
                                        className="property-filter-search"
                                        type="search"
                                        placeholder="Search values"
                                        value={filterValueSearch}
                                        onChange={(event) => setFilterValueSearch(event.target.value)}
                                    />
                                    <div className="property-filter-actions">
                                        <button
                                            type="button"
                                            onClick={() => setFilterSelectedValues(filterValues.map(({ id }) => id))}
                                        >
                                            Select all
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setFilterPropertyKey("");
                                                setFilterSelectedValues([]);
                                                setFilterValueSearch("");
                                            }}
                                        >
                                            Clear filter
                                        </button>
                                    </div>
                                    <div className="property-filter-values">
                                        {visibleFilterValues.map(({ id, value, count }) => (
                                            <label key={id} className="property-filter-value">
                                                <input
                                                    type="checkbox"
                                                    checked={filterSelectedValues.includes(id)}
                                                    onChange={() => toggleFilterValue(id)}
                                                />
                                                <span>{value}</span>
                                                <small>{count}</small>
                                            </label>
                                        ))}
                                        {visibleFilterValues.length === 0 && (
                                            <p>No values found for this property.</p>
                                        )}
                                    </div>
                                </>
                            )}
                        </>
                    )}
                </section>
            )}
            {activePanoramaStation && (
                <PanoramaOverlay
                    station={activePanoramaStation}
                    onClose={() => setActivePanoramaStationId(null)}
                />
            )}
            <div className="viewer-side-tools">
                {onExit && (
                    <button type="button" className="exit-scene-button" onClick={onExit}>
                        Back to project
                    </button>
                )}
                <section className="issue-controls" aria-label="Scene issues">
                    <div className="issue-controls-header">
                        <h2>Issues</h2>
                        <span>
                            <button type="button" onClick={() => openIssueManager()}>Manage</button>
                            <button type="button" onClick={startIssueCreation}>New issue</button>
                        </span>
                    </div>
                    {issues.length === 0 && <p>No issues have been created.</p>}
                    <div className="scene-issue-list">
                        {issues.map((issue) => (
                            <button
                                key={issue.id}
                                type="button"
                                className="scene-issue"
                                onClick={() => openIssueManager(issue)}
                            >
                                <img src={issue.screenshotSrc} alt="" />
                                <span>
                                    <strong>{issue.title}</strong>
                                    <small>{new Date(issue.createdAt).toLocaleString()}</small>
                                </span>
                            </button>
                        ))}
                    </div>
                    {issueError && !issueDraft && <p className="issue-error">{issueError}</p>}
                </section>
            </div>
            {isSelectionPanelVisible && <aside className="selection-panel">
                <div className="selection-panel-header">
                    <h2>Selection</h2>
                    <button
                        type="button"
                        className="properties-button"
                        onClick={() => void openPropertyConfiguration()}
                    >
                        Properties
                    </button>
                </div>
                {!selection && <p>Select an element in the model.</p>}
                {selection && !selectedElement && (
                    <p>Metadata is not available for this element.</p>
                )}
                {selectedElement && (
                        <>
                            <p>{selectedElement.name}</p>
                            <div className="property-list">
                            {selectedProperties.map((property) => (
                                <div key={property.key} className="property-row" title={property.propertySetName}>
                                    <span>{property.name}</span>
                                    <strong>{String(property.value)}</strong>
                                    <button
                                        type="button"
                                        className="property-filter-button"
                                        aria-label={`Filter by ${property.name}: ${String(property.value)}`}
                                        title={`Filter: ${property.name} = ${String(property.value)}`}
                                        onClick={() => void filterBySelectedProperty(property)}
                                    >
                                        <ToolIcon name="filter" />
                                    </button>
                                </div>
                            ))}
                            {selectedProperties.length === 0 && (
                                <p className="selection-note">No configured properties are available for this element.</p>
                            )}
                        </div>
                        <button
                            type="button"
                            className="show-all-button"
                            disabled={isPropertyRetrievalLoading}
                            onClick={() => void toggleAllProperties()}
                        >
                            {isPropertyRetrievalLoading
                                ? "Loading properties..."
                                : showAllProperties ? "Show configured properties" : "Show all properties"}
                        </button>
                        {propertyRetrievalError && <p className="selection-note">{propertyRetrievalError}</p>}
                    </>
                )}
            </aside>}
            <p className="viewer-status">{status}</p>
            {isPropertyConfigurationOpen && (
                <div className="property-dialog-backdrop" role="presentation">
                    <section className="property-dialog" role="dialog" aria-modal="true" aria-labelledby="property-dialog-title">
                        <div className="property-dialog-header">
                            <div>
                                <h2 id="property-dialog-title">Visible properties</h2>
                                <p>Choose the fields shown in the compact selection panel.</p>
                            </div>
                            <button type="button" onClick={() => setIsPropertyConfigurationOpen(false)}>Close</button>
                        </div>
                        <input
                            className="property-search"
                            type="search"
                            placeholder="Search properties"
                            value={propertySearch}
                            onChange={(event) => setPropertySearch(event.target.value)}
                        />
                        <div className="property-dialog-actions">
                            <button type="button" onClick={() => setVisiblePropertyKeys(getDefaultPropertyKeys(availableProperties))}>Use defaults</button>
                            <button type="button" onClick={() => setVisiblePropertyKeys([])}>Clear selection</button>
                        </div>
                        {isPropertyCatalogLoading && <p className="selection-note">Loading available properties...</p>}
                        {propertyCatalogError && <p className="property-view-error">{propertyCatalogError}</p>}
                        <section className="property-view-manager" aria-label="Saved property views">
                            <div className="property-view-save-row">
                                <input
                                    type="text"
                                    placeholder="View name"
                                    value={propertyViewName}
                                    onChange={(event) => setPropertyViewName(event.target.value)}
                                />
                                <button
                                    type="button"
                                    disabled={isPropertyViewSaving || !propertyViewName.trim()}
                                    onClick={() => void savePropertyView()}
                                >
                                    {isPropertyViewSaving ? "Saving..." : "Save view"}
                                </button>
                            </div>
                            {propertyViews.length > 0 && (
                                <div className="property-view-list">
                                    {propertyViews.map((view) => (
                                        <div key={view.id} className="property-view-item">
                                            <strong>{view.name}</strong>
                                            <span>{view.propertyKeys.length} properties</span>
                                            <button
                                                type="button"
                                                onClick={() => setVisiblePropertyKeys(normalizePropertyKeys(view.propertyKeys, availableProperties))}
                                            >
                                                Apply
                                            </button>
                                            <button
                                                type="button"
                                                disabled={activePropertyViewId === view.id}
                                                onClick={() => void removePropertyView(view)}
                                            >
                                                Delete
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                            {propertyViewError && <p className="property-view-error">{propertyViewError}</p>}
                        </section>
                        <div className="available-properties-list">
                            {filteredAvailableProperties.map((property) => (
                                <label key={property.key} className="available-property">
                                    <input
                                        type="checkbox"
                                        checked={selectedPropertyKeys.has(property.key)}
                                        onChange={() => toggleVisibleProperty(property.key)}
                                    />
                                    <span>
                                        <strong>{property.propertyName}</strong>
                                        <small>{property.propertySetName}</small>
                                    </span>
                                </label>
                            ))}
                        </div>
                    </section>
                </div>
            )}
            {issueDraft && (
                <div className="issue-dialog-backdrop" role="presentation">
                    <form
                        className="issue-dialog"
                        onSubmit={(event) => {
                            event.preventDefault();
                            void saveIssue();
                        }}
                    >
                        <div className="issue-dialog-header">
                            <div>
                                <h2>New issue</h2>
                                <p>The snapshot preserves the current selection visually.</p>
                            </div>
                            <button
                                type="button"
                                disabled={isIssueSaving}
                                onClick={() => setIssueDraft(null)}
                            >
                                Close
                            </button>
                        </div>
                        <img
                            className="issue-snapshot"
                            src={issueDraft.screenshotData}
                            alt="Captured scene"
                        />
                        <label>
                            Title
                            <input
                                autoFocus
                                value={issueTitle}
                                onChange={(event) => setIssueTitle(event.target.value)}
                                placeholder="Pipe is in the wrong position"
                            />
                        </label>
                        <label>
                            Description <span className="issue-optional">(optional)</span>
                            <textarea
                                rows={5}
                                value={issueDescription}
                                onChange={(event) => setIssueDescription(event.target.value)}
                                placeholder="Describe the issue..."
                            />
                        </label>
                        <label>
                            Category <span className="issue-optional">(optional)</span>
                            <input
                                value={issueCategory}
                                onChange={(event) => setIssueCategory(event.target.value)}
                                placeholder="Coordination"
                            />
                        </label>
                        {issueDraft.selection && (
                            <p className="issue-selection-reference">
                                Optional reference: {issueDraft.selection.name
                                    ?? issueDraft.selection.globalId
                                    ?? issueDraft.selection.rendererObjectId}
                            </p>
                        )}
                        {issueError && <p className="issue-error">{issueError}</p>}
                        <div className="issue-dialog-actions">
                            <button
                                type="button"
                                disabled={isIssueSaving}
                                onClick={() => setIssueDraft(null)}
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                className="issue-save-button"
                                disabled={isIssueSaving || !issueTitle.trim()}
                            >
                                {isIssueSaving ? "Saving..." : "Save issue"}
                            </button>
                        </div>
                    </form>
                </div>
            )}
            {isIssueManagerOpen && (
                <div className="issue-manager-backdrop" role="presentation">
                    <section
                        className="issue-manager"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="issue-manager-title"
                    >
                        <header className="issue-manager-header">
                            <div>
                                <h2 id="issue-manager-title">Issues</h2>
                                <p>{issues.length} issue{issues.length === 1 ? "" : "s"} in this project</p>
                            </div>
                            <button type="button" onClick={() => setIsIssueManagerOpen(false)}>Close</button>
                        </header>
                        <div className="issue-manager-content">
                            <section className="issue-manager-list" aria-label="Issue list">
                                <input
                                    className="issue-manager-search"
                                    type="search"
                                    placeholder="Search title or description"
                                    value={issueSearch}
                                    onChange={(event) => setIssueSearch(event.target.value)}
                                />
                                <div className="issue-filter-buttons" aria-label="Issue status filter">
                                    {(["all", "open", "resolved", "closed"] as const).map((filter) => (
                                        <button
                                            key={filter}
                                            type="button"
                                            className={issueStatusFilter === filter ? "is-active" : ""}
                                            onClick={() => setIssueStatusFilter(filter)}
                                        >
                                            {filter === "all" ? "All" : filter[0].toUpperCase() + filter.slice(1)}
                                        </button>
                                    ))}
                                </div>
                                <select
                                    className="issue-category-filter"
                                    value={issueCategoryFilter}
                                    onChange={(event) => setIssueCategoryFilter(event.target.value)}
                                    aria-label="Issue category filter"
                                >
                                    <option value="all">All categories</option>
                                    {issueCategories.map((category) => (
                                        <option key={category} value={category}>{category}</option>
                                    ))}
                                </select>
                                <div className="issue-manager-items">
                                    {filteredIssues.map((issue) => (
                                        <button
                                            key={issue.id}
                                            type="button"
                                            className={selectedIssueId === issue.id
                                                ? "issue-manager-item is-selected"
                                                : "issue-manager-item"}
                                            onClick={() => setSelectedIssueId(issue.id)}
                                        >
                                            <img src={issue.screenshotSrc} alt="" />
                                            <span className="issue-manager-copy">
                                                <strong>{issue.title}</strong>
                                                <span className="issue-manager-meta">
                                                    <small>{new Date(issue.updatedAt).toLocaleString()}</small>
                                                    <em className={`issue-status issue-status-${issue.status}`}>
                                                        {issue.status[0].toUpperCase() + issue.status.slice(1)}
                                                    </em>
                                                </span>
                                                {issue.category && <small className="issue-category-label">{issue.category}</small>}
                                            </span>
                                        </button>
                                    ))}
                                    {filteredIssues.length === 0 && (
                                        <p className="issue-empty-state">No issues match the current filter.</p>
                                    )}
                                </div>
                            </section>
                            <section className="issue-detail" aria-label="Issue details">
                                {!selectedIssue && <p>Select an issue to view its details.</p>}
                                {selectedIssue && (
                                    <>
                                        <img
                                            className="issue-detail-snapshot"
                                            src={selectedIssue.screenshotSrc}
                                            alt={`Scene snapshot for ${selectedIssue.title}`}
                                        />
                                        {!isIssueEditing && <>
                                            <div className="issue-detail-title-row">
                                                <h3>{selectedIssue.title}</h3>
                                                <span className={`issue-status issue-status-${selectedIssue.status}`}>
                                                    {selectedIssue.status[0].toUpperCase() + selectedIssue.status.slice(1)}
                                                </span>
                                            </div>
                                            <p className="issue-detail-date">
                                                Created {new Date(selectedIssue.createdAt).toLocaleString()}
                                            </p>
                                            {selectedIssue.category && <p className="issue-detail-category">Category: {selectedIssue.category}</p>}
                                            <p className="issue-detail-description">{selectedIssue.description}</p>
                                        </>}
                                        {isIssueEditing && <div className="issue-edit-form">
                                            <label>Title<input value={editIssueTitle} onChange={(event) => setEditIssueTitle(event.target.value)} /></label>
                                            <label>Category <span className="issue-optional">(optional)</span><input value={editIssueCategory} onChange={(event) => setEditIssueCategory(event.target.value)} /></label>
                                            <label>Description<textarea rows={5} value={editIssueDescription} onChange={(event) => setEditIssueDescription(event.target.value)} /></label>
                                            <div className="issue-detail-actions">
                                                <button type="button" disabled={isIssueStatusUpdating} onClick={() => void saveIssueEdits(selectedIssue)}>Save changes</button>
                                                <button type="button" disabled={isIssueStatusUpdating} onClick={() => setIsIssueEditing(false)}>Cancel</button>
                                            </div>
                                        </div>}
                                        {selectedIssue.selection && (
                                            <p className="issue-selection-reference">
                                                Optional reference: {selectedIssue.selection.name
                                                    ?? selectedIssue.selection.globalId
                                                    ?? selectedIssue.selection.rendererObjectId}
                                            </p>
                                        )}
                                        <div className="issue-detail-actions">
                                            <button
                                                type="button"
                                                className="issue-open-scene-button"
                                                onClick={() => {
                                                    openIssue(selectedIssue);
                                                    setIsIssueManagerOpen(false);
                                                }}
                                            >
                                                Open in scene
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => startIssueEditing(selectedIssue)}
                                            >
                                                Edit issue
                                            </button>
                                            <label className="issue-status-select">
                                                Status
                                                <select
                                                    value={selectedIssue.status}
                                                    disabled={isIssueStatusUpdating}
                                                    onChange={(event) => void changeIssueStatus(
                                                        selectedIssue,
                                                        event.target.value as ProjectIssue["status"],
                                                    )}
                                                >
                                                    <option value="open">Open</option>
                                                    <option value="resolved">Resolved</option>
                                                    <option value="closed">Closed</option>
                                                </select>
                                            </label>
                                        </div>
                                        <section className="issue-comments" aria-label="Issue comments">
                                            <h4>Comments</h4>
                                            {(selectedIssue.comments ?? []).map((comment) => (
                                                <article key={comment.id} className="issue-comment">
                                                    <strong>{comment.authorName}</strong>
                                                    <time>{new Date(comment.createdAt).toLocaleString()}</time>
                                                    <p>{comment.body}</p>
                                                </article>
                                            ))}
                                            {(selectedIssue.comments?.length ?? 0) === 0 && <p className="issue-empty-state">No comments yet.</p>}
                                            <div className="issue-comment-form">
                                                <input value={commentAuthorName} onChange={(event) => setCommentAuthorName(event.target.value)} placeholder="Your name" />
                                                <textarea rows={3} value={commentBody} onChange={(event) => setCommentBody(event.target.value)} placeholder="Write a comment..." />
                                                <button type="button" disabled={isCommentSaving || !commentAuthorName.trim() || !commentBody.trim()} onClick={() => void saveIssueComment(selectedIssue)}>
                                                    {isCommentSaving ? "Saving..." : "Add comment"}
                                                </button>
                                            </div>
                                        </section>
                                    </>
                                )}
                                {issueError && <p className="issue-error">{issueError}</p>}
                            </section>
                        </div>
                    </section>
                </div>
            )}
        </main>
    );
}

export default Viewer;
