import {
    BCFViewpointsPlugin,
    DistanceMeasurementEditMouseControl,
    DistanceMeasurementsMouseControl,
    DistanceMeasurementsPlugin,
    LASLoaderPlugin,
    SectionPlanesPlugin,
    Viewer as XeokitViewer,
    XKTLoaderPlugin,
} from "@xeokit/xeokit-sdk";
import type { DistanceMeasurement } from "@xeokit/xeokit-sdk";
import type { DisplayMode } from "../models/ProjectDisplayView";
import type {
    ElementSelection,
    ModelPackage,
    PointCloudPackage,
} from "../models/ModelPackage";
import type { ViewerAdapter, ViewerAdapterEvents } from "./ViewerAdapter";

/** Xeokit implementation of the renderer-independent ViewerAdapter contract. */
export class ViewerService implements ViewerAdapter {

    private static readonly MAX_SCENE_SPAN_METERS = 1000;
    private viewer: XeokitViewer | null = null;
    private bcfViewpoints: BCFViewpointsPlugin | null = null;
    private sectionPlanes: SectionPlanesPlugin | null = null;
    private activeSectionPlaneId: string | null = null;
    private planSectionPlaneIds: string[] = [];
    private planVisibleObjectIds: Set<string> | null = null;
    private planMinimumOrthoScale: number | null = null;
    private manuallyHiddenObjectIds = new Set<string>();
    private isolatedObjectId: string | null = null;
    private propertyVisibleObjectIds: Set<string> | null = null;
    private colorOverrideActive = false;
    private isCutMode = false;
    private distanceMeasurements: DistanceMeasurementsPlugin | null = null;
    private distanceMeasurementControl: DistanceMeasurementsMouseControl | null = null;
    private distanceEditControl: DistanceMeasurementEditMouseControl | null = null;
    private latestDistanceMeasurement: DistanceMeasurement | null = null;
    private panoramaMarkerCameraSubscriptions: string[] = [];
    private initialZoomRetryTimer: number | null = null;
    private readonly loadedPackages = new Map<string, {
        sceneModel: {
            visible: boolean;
            pickable: boolean;
            objects: Record<string, unknown>;
            aabb: number[];
        };
        filterable: boolean;
    }>();

    public initialize(
        canvas: HTMLCanvasElement,
        modelPackages: ModelPackage[],
        pointCloudPackages: PointCloudPackage[],
        events: ViewerAdapterEvents,
    ): void {

        if (this.viewer) {
            return;
        }

        const unsupportedModel = modelPackages.find(
            (modelPackage) => modelPackage.geometry.format !== "xkt",
        );
        if (unsupportedModel) {
            throw new Error(
                `Xeokit adapter cannot load ${unsupportedModel.geometry.format} geometry.`,
            );
        }

        this.viewer = new XeokitViewer({
            canvasElement: canvas,
            transparent: false,
            // Large coordinated scenes can otherwise lose depth-buffer
            // precision at distance, which makes near-coplanar surfaces
            // flicker or look patchy. This is a renderer setting only; the
            // source geometry stays unchanged.
            logarithmicDepthBufferEnabled: true,
            // SAO is costly on large IFC scenes and produces visible noise on
            // thin, overlapping MEP geometry. The clean shaded view is both
            // faster and closer to the desired visual target.
            saoEnabled: false,
        });
        const viewer = this.viewer;
        // Keep the WebGL clear color aligned with the viewer shell instead of xeokit's white default.
        const sceneCanvas = viewer.scene.canvas as unknown as {
            backgroundColorFromAmbientLight: boolean;
            backgroundColor: number[];
        };
        sceneCanvas.backgroundColorFromAmbientLight = false;
        sceneCanvas.backgroundColor = [154 / 255, 168 / 255, 186 / 255];
        // Keep a point cloud readable without letting its screen-space points
        // visually blanket overlapping IFC surfaces from a distance.
        viewer.scene.pointsMaterial.pointSize = 1;
        viewer.scene.pointsMaterial.perspectivePoints = true;
        viewer.scene.pointsMaterial.minPerspectivePointSize = 1;
        viewer.scene.pointsMaterial.maxPerspectivePointSize = 3;
        // Panorama locations are projected as DOM controls, therefore they do
        // not need xeokit's Marker occlusion pass. That pass renders into an
        // internal black framebuffer; on some GPU/driver combinations a stale
        // Marker makes that framebuffer leak into the visible scene as black
        // rectangles. Disable the unused pass for this Viewer instance.
        const sceneWithoutMarkerOcclusion = viewer.scene as typeof viewer.scene & {
            doOcclusionTest: () => void;
        };
        sceneWithoutMarkerOcclusion.doOcclusionTest = () => {};
        // Keep wheel movement continuous instead of applying large, discrete
        // jumps. The small inertia makes a trackpad or mouse wheel glide to a
        // stop while still keeping close-up work controllable.
        viewer.cameraControl.mouseWheelDollyRate = 100;
        viewer.cameraControl.dollyInertia = 0.55;
        viewer.cameraControl.dollyProximityThreshold = 30;
        viewer.cameraControl.dollyMinSpeed = 0.04;
        viewer.scene.on("tick", () => {
            if (this.planMinimumOrthoScale !== null && viewer.camera.ortho.scale < this.planMinimumOrthoScale) {
                viewer.camera.ortho.scale = this.planMinimumOrthoScale;
            }
        });
        this.bcfViewpoints = new BCFViewpointsPlugin(viewer, {
            originatingSystem: "SymetrIQ",
            authoringTool: "SymetrIQ Viewer",
        });
        this.sectionPlanes = new SectionPlanesPlugin(viewer, {
            overviewVisible: false,
        });
        this.distanceMeasurements = new DistanceMeasurementsPlugin(viewer, {
            container: canvas.parentElement ?? document.body,
            defaultAxisVisible: true,
            defaultColor: "#74c0fc",
            zIndex: 5,
        });
        this.distanceMeasurementControl = new DistanceMeasurementsMouseControl(
            this.distanceMeasurements,
            { snapping: true },
        );
        this.distanceMeasurements.on("measurementCreated", (measurement: DistanceMeasurement) => {
            const formattedMeasurement = measurement as DistanceMeasurement & {
                labelStringFormat: (length: number) => string;
            };
            formattedMeasurement.labelStringFormat = (length: number) =>
                ` ${Math.round(length * 1000)} mm`;
        });
        this.distanceMeasurements.on("measurementEnd", (measurement: DistanceMeasurement) => {
            this.latestDistanceMeasurement = measurement;
            events.onDistanceMeasurementCreated?.();
        });

        const xktLoader = new XKTLoaderPlugin(viewer);
        const totalPackages = modelPackages.length + pointCloudPackages.length;
        let loadedPackages = 0;
        const onPackageLoaded = () => {
            loadedPackages += 1;
            if (loadedPackages === totalPackages) {
                if (this.exceedsMaximumSceneSpan()) {
                    events.onModelAreaExceeded?.(ViewerService.MAX_SCENE_SPAN_METERS);
                    this.zoomAllWithinMaximumSceneSpan();
                    return;
                }
                this.zoomAllWhenSceneIsReady();
                events.onModelLoaded?.();
            }
        };

        modelPackages.forEach((modelPackage) => {
            const sceneModel = xktLoader.load({
                id: modelPackage.id,
                src: modelPackage.geometry.src,
                edges: false,
                globalizeObjectIds: true,
                ...modelPackage.transform,
            });
            this.loadedPackages.set(modelPackage.id, { sceneModel, filterable: true });

            sceneModel.on("loaded", onPackageLoaded);
            sceneModel.on("error", (message: string) => {
                events.onModelError?.(message);
            });
        });

        pointCloudPackages.forEach((pointCloudPackage) => {
            const lasLoader = new LASLoaderPlugin(viewer, {
                skip: Math.max(1, pointCloudPackage.pointStride ?? 1),
                colorDepth: "auto",
                fp64: 1,
                transform: pointCloudPackage.lasTransform,
            });
            const pointCloud = lasLoader.load({
                id: pointCloudPackage.id,
                src: pointCloudPackage.source.src,
                loadMetadata: false,
                ...pointCloudPackage.transform,
            });
            this.loadedPackages.set(pointCloudPackage.id, { sceneModel: pointCloud, filterable: false });

            pointCloud.on("loaded", onPackageLoaded);
            pointCloud.on("error", (message: string) => {
                events.onModelError?.(message);
            });
        });

        if (totalPackages === 0) {
            events.onModelError?.("No model or point cloud package was provided.");
        }

        this.viewer.cameraControl.on("picked", (event) => {
            if (!event.entity) {
                return;
            }

            if (this.isCutMode || this.distanceMeasurementControl?.active || this.distanceEditControl) {
                return;
            }

            const entityId = String(event.entity.id);
            const modelId = this.findModelId(entityId, modelPackages);
            // Point clouds provide visual reference only: never turn an
            // accidental click on a point into a selected scene element.
            if (!modelPackages.some((modelPackage) => modelPackage.id === modelId)) {
                return;
            }

            this.viewer?.scene.setObjectsSelected(
                this.viewer.scene.selectedObjectIds,
                false,
            );
            event.entity.selected = true;
            const selection = {
                modelId,
                rendererObjectId: this.getLocalObjectId(entityId, modelId),
            };
            events.onSelectionChanged?.(selection);

            const surfacePick = viewer.scene.pick({
                canvasPos: event.canvasPos,
                pickSurface: true,
                pickSurfaceNormal: true,
            });
            events.onElementActionContext?.({
                selection,
                canvasPos: [event.canvasPos[0], event.canvasPos[1]],
                ...(surfacePick?.worldPos ? {
                    worldPos: [surfacePick.worldPos[0], surfacePick.worldPos[1], surfacePick.worldPos[2]],
                } : {}),
                ...(surfacePick?.worldNormal ? {
                    worldNormal: [surfacePick.worldNormal[0], surfacePick.worldNormal[1], surfacePick.worldNormal[2]],
                } : {}),
            });
        });

        this.viewer.cameraControl.on("pickedSurface", (event) => {
            if (!this.isCutMode || !this.viewer) {
                return;
            }
            const surfacePick = this.viewer.scene.pick({
                canvasPos: event.canvasPos,
                pickSurface: true,
                pickSurfaceNormal: true,
            });
            if (!surfacePick?.worldPos) {
                return;
            }
            this.createSectionPlane(surfacePick.worldPos, surfacePick.worldNormal);
            this.isCutMode = false;
            events.onCutPlaneCreated?.();
        });

        this.viewer.cameraControl.on("pickedNothing", () => {
            if (this.distanceMeasurementControl?.active || this.distanceEditControl) {
                return;
            }
            this.viewer?.scene.setObjectsSelected(
                this.viewer.scene.selectedObjectIds,
                false,
            );
            events.onSelectionChanged?.(null);
            events.onElementActionContext?.(null);
        });

        console.log("ViewerService initialized");
    }

    public destroy(): void {

        if (this.initialZoomRetryTimer !== null) {
            window.clearTimeout(this.initialZoomRetryTimer);
            this.initialZoomRetryTimer = null;
        }
        this.distanceEditControl?.deactivate();
        this.distanceEditControl = null;
        this.distanceMeasurementControl?.destroy();
        this.distanceMeasurementControl = null;
        this.distanceMeasurements?.destroy();
        this.distanceMeasurements = null;
        this.latestDistanceMeasurement = null;
        this.clearPanoramaMarkers();
        this.sectionPlanes?.destroy();
        this.sectionPlanes = null;
        this.activeSectionPlaneId = null;
        this.isCutMode = false;
        this.loadedPackages.clear();
        this.manuallyHiddenObjectIds.clear();
        this.isolatedObjectId = null;
        this.propertyVisibleObjectIds = null;
        this.planVisibleObjectIds = null;
        this.bcfViewpoints?.destroy();
        this.bcfViewpoints = null;

        if (this.viewer) {
            this.viewer.destroy();
            this.viewer = null;
        }
    }

    public getViewer(): XeokitViewer {

        if (!this.viewer) {
            throw new Error("Viewer is not initialized.");
        }

        return this.viewer;
    }

    /** Creates camera-tracked DOM marker positions without xeokit's occlusion framebuffer. */
    public setPanoramaMarkers(
        stations: Array<{ id: string; position: [number, number, number] }>,
        onUpdate: (markers: Array<{ id: string; canvasPos: [number, number]; visible: boolean }>) => void,
    ): void {
        this.clearPanoramaMarkers();
        if (!this.viewer) return;

        const viewer = this.viewer;
        const camera = viewer.camera as typeof viewer.camera & {
            projectWorldPos: (worldPos: ArrayLike<number>) => ArrayLike<number>;
        };
        const publish = () => {
            const boundary = (viewer.scene.canvas as unknown as { boundary: number[] }).boundary;
            const forward = [
                camera.look[0] - camera.eye[0],
                camera.look[1] - camera.eye[1],
                camera.look[2] - camera.eye[2],
            ];
            onUpdate(stations.map((station) => {
                const canvasPos = camera.projectWorldPos(station.position);
                const depth = (station.position[0] - camera.eye[0]) * forward[0]
                    + (station.position[1] - camera.eye[1]) * forward[1]
                    + (station.position[2] - camera.eye[2]) * forward[2];
                return {
                    id: station.id,
                    canvasPos: [canvasPos[0], canvasPos[1]],
                    // Markers behind the camera or outside the canvas are not clickable.
                    visible: depth > 0
                        && canvasPos[0] >= 0 && canvasPos[0] <= boundary[2]
                        && canvasPos[1] >= 0 && canvasPos[1] <= boundary[3],
                };
            }));
        };
        this.panoramaMarkerCameraSubscriptions = [
            camera.on("matrix", publish),
            camera.on("projMatrix", publish),
        ];
        publish();
    }

    public clearPanoramaMarkers(): void {
        if (this.viewer) {
            this.panoramaMarkerCameraSubscriptions.forEach((subscription) =>
                this.viewer?.camera.off(subscription));
        }
        this.panoramaMarkerCameraSubscriptions = [];
    }

    /** Frames the union of object bounds belonging to currently visible packages only. */
    public zoomAll(): boolean {
        if (!this.viewer) {
            return false;
        }
        const visibleObjectIds = [...this.loadedPackages.values()]
            .filter((loadedPackage) => loadedPackage.sceneModel.visible)
            .flatMap((loadedPackage) => Object.keys(loadedPackage.sceneModel.objects))
            .filter((objectId) => this.viewer?.scene.visibleObjects[objectId]);
        if (visibleObjectIds.length === 0) {
            return false;
        }
        this.viewer.cameraFlight.flyTo({
            aabb: this.viewer.scene.getAABB(visibleObjectIds),
        });
        return true;
    }

    /**
     * Load events can precede xeokit's visible-object registry. Keep trying
     * briefly so entering a Scene gets the same framing as clicking Zoom All.
     */
    private zoomAllWhenSceneIsReady(attemptsRemaining = 5): void {
        // A package may report "loaded" before its final renderable bounds are
        // available. Do not stop at the first valid AABB: repeat briefly so
        // the last fit includes every completed IFC and point cloud.
        this.zoomAll();
        if (attemptsRemaining === 0) {
            return;
        }
        this.initialZoomRetryTimer = window.setTimeout(() => {
            this.initialZoomRetryTimer = null;
            this.zoomAllWhenSceneIsReady(attemptsRemaining - 1);
        }, 250);
    }

    /**
     * When a package is in a different coordinate system, keep the warning but
     * still frame the first coherent (at most 1 km) group of visible packages.
     * Models are registered before point clouds, so an outlying point cloud
     * does not prevent the IFC scene from being usable.
     */
    private zoomAllWithinMaximumSceneSpan(): boolean {
        if (!this.viewer) {
            return false;
        }

        let acceptedAabb: number[] | null = null;
        const acceptedObjectIds: string[] = [];

        this.loadedPackages.forEach((loadedPackage) => {
            if (!loadedPackage.sceneModel.visible) {
                return;
            }
            const objectIds = Object.keys(loadedPackage.sceneModel.objects)
                .filter((objectId) => this.viewer?.scene.visibleObjects[objectId]);
            if (objectIds.length === 0) {
                return;
            }

            const packageAabb = loadedPackage.sceneModel.aabb;
            const candidateAabb = acceptedAabb
                ? this.combineAABBs(acceptedAabb, packageAabb)
                : [...packageAabb];
            if (this.getMaximumAABBSpan(candidateAabb) > ViewerService.MAX_SCENE_SPAN_METERS) {
                return;
            }

            acceptedAabb = candidateAabb;
            acceptedObjectIds.push(...objectIds);
        });

        if (acceptedObjectIds.length === 0) {
            return false;
        }
        this.viewer.cameraFlight.flyTo({
            aabb: this.viewer.scene.getAABB(acceptedObjectIds),
        });
        return true;
    }

    /** Arms the next surface click to create an interactive clipping plane. */
    public setCutMode(enabled: boolean): void {
        if (enabled) {
            this.setDistanceMeasurementMode(false);
            this.stopEditingDistanceMeasurement();
        }
        this.isCutMode = enabled;
    }

    /** Activates or deactivates repeated point-to-point distance creation. */
    public setDistanceMeasurementMode(enabled: boolean): void {
        if (!this.distanceMeasurementControl) {
            return;
        }
        if (enabled) {
            this.isCutMode = false;
            this.stopEditingDistanceMeasurement();
            this.distanceMeasurementControl.activate();
        } else {
            this.distanceMeasurementControl.deactivate();
        }
    }

    /** Lets the user drag the two endpoints of the most recent measurement. */
    public startEditingLatestDistanceMeasurement(): boolean {
        if (!this.latestDistanceMeasurement) {
            return false;
        }
        this.setDistanceMeasurementMode(false);
        this.stopEditingDistanceMeasurement();
        this.distanceEditControl = new DistanceMeasurementEditMouseControl(
            this.latestDistanceMeasurement,
            { snapping: true },
        );
        return true;
    }

    public stopEditingDistanceMeasurement(): void {
        this.distanceEditControl?.deactivate();
        this.distanceEditControl = null;
    }

    public clearDistanceMeasurements(): void {
        this.setDistanceMeasurementMode(false);
        this.stopEditingDistanceMeasurement();
        this.distanceMeasurements?.clear();
        this.latestDistanceMeasurement = null;
    }

    /** Inverts the currently active clipping plane. */
    public flipActiveSectionPlane(): void {
        if (!this.activeSectionPlaneId || !this.sectionPlanes) {
            return;
        }
        const sectionPlane = this.sectionPlanes.sectionPlanes[this.activeSectionPlaneId];
        if (sectionPlane) {
            sectionPlane.dir = sectionPlane.dir.map((value: number) => -value);
        }
    }

    /** Removes every clipping plane and restores the complete model. */
    public clearSectionPlanes(): void {
        this.viewer?.scene.clearSectionPlanes();
        this.activeSectionPlaneId = null;
        this.isCutMode = false;
    }

    /** Enters a locked, orthographic plan view using a level-relative view range. */
    public enterPlanView(levelElevation: number, range: { lower: number; cut: number; upper: number }): boolean {
        if (!this.viewer || !this.sectionPlanes) return false;
        this.exitPlanView();
        const objectIds = this.getIfcObjectIds();
        if (objectIds.length === 0) return false;
        this.planVisibleObjectIds = null;
        const aabb = this.viewer.scene.getAABB(objectIds);
        const centerX = (aabb[0] + aabb[3]) / 2;
        const centerZ = (aabb[2] + aabb[5]) / 2;
        const span = Math.max(aabb[3] - aabb[0], aabb[5] - aabb[2], 10);

        // Keep the geometry below the floor-relative Cut height. In this
        // XKT coordinate system, a negative Y direction removes the geometry
        // above the plane and leaves an actual cross-section at the cut.
        const cutPlane = this.sectionPlanes.createSectionPlane({
            pos: [centerX, levelElevation + range.cut, centerZ],
            dir: [0, -1, 0],
        });
        this.planSectionPlaneIds = [cutPlane.id];
        this.applyElementVisibility();
        this.viewer.camera.projection = "ortho";
        this.viewer.cameraControl.navMode = "planView";
        this.viewer.cameraControl.mouseWheelDollyRate = 55;
        this.viewer.cameraControl.dollyMinSpeed = 0.01;
        this.viewer.camera.eye = [centerX, levelElevation + span * 2, centerZ];
        this.viewer.camera.look = [centerX, levelElevation + range.cut, centerZ];
        this.viewer.camera.up = [0, 0, -1];
        this.viewer.camera.ortho.scale = span * 1.2;
        this.planMinimumOrthoScale = Math.max(span * 0.05, 2);
        (this.viewer.scene.canvas as unknown as { backgroundColor: number[] }).backgroundColor = [1, 1, 1];
        this.viewer.scene.setObjectsColorized(objectIds, [1, 1, 1]);
        this.viewer.scene.setObjectsEdges(objectIds, true);
        return true;
    }

    public exitPlanView(): void {
        if (!this.viewer || !this.sectionPlanes) return;
        this.planSectionPlaneIds.forEach((id) => this.sectionPlanes?.destroySectionPlane(id));
        this.planSectionPlaneIds = [];
        this.planVisibleObjectIds = null;
        this.viewer.camera.projection = "perspective";
        this.viewer.cameraControl.navMode = "orbit";
        this.viewer.cameraControl.mouseWheelDollyRate = 350;
        this.viewer.cameraControl.dollyMinSpeed = 0.04;
        this.planMinimumOrthoScale = null;
        (this.viewer.scene.canvas as unknown as { backgroundColor: number[] }).backgroundColor = [154 / 255, 168 / 255, 186 / 255];
        const objectIds = this.getIfcObjectIds();
        this.viewer.scene.setObjectsEdges(objectIds, false);
        // Clear the temporary plan-white multiplier so the original XKT
        // material colours return in the 3D scene.
        (this.viewer.scene as unknown as { setObjectsColorized: (ids: string[], color: null) => boolean }).setObjectsColorized(objectIds, null);
        this.applyElementVisibility();
    }

    /** Hides one IFC element without affecting any point-cloud package. */
    public hideElement(selection: ElementSelection): void {
        this.manuallyHiddenObjectIds.add(this.getObjectId(selection));
        this.applyElementVisibility();
    }

    /** Shows only one IFC element; point-cloud package visibility is unchanged. */
    public isolateElement(selection: ElementSelection): void {
        this.isolatedObjectId = this.getObjectId(selection);
        this.applyElementVisibility();
    }

    /** Clears Hide/Isolate state and reapplies any active property filter. */
    public showAllElements(): void {
        this.manuallyHiddenObjectIds.clear();
        this.isolatedObjectId = null;
        this.applyElementVisibility();
    }

    /** Applies one global IFC display mode. Point-cloud packages are unchanged. */
    public setDisplayMode(_mode: DisplayMode, opacity: number): void {
        if (!this.viewer) return;
        const objectIds = this.getIfcObjectIds();
        // Keep the source material colours. Xeokit's native xray state uses
        // an emphasis material, which intentionally replaces them with one
        // tint. A transparent shaded model is the useful X-Ray equivalent.
        this.viewer.scene.setObjectsXRayed(objectIds, false);
        this.viewer.scene.setObjectsEdges(objectIds, false);
        this.viewer.scene.setObjectsOpacity(objectIds, Math.max(0, Math.min(1, opacity)));
    }

    /** Applies a metadata-selected color override and resets every other IFC element to white. */
    public setColorOverride(objectIds: string[], color?: [number, number, number]): void {
        if (!this.viewer) return;
        const ifcObjectIds = this.getIfcObjectIds();
        if (color && objectIds.length > 0) {
            this.viewer.scene.setObjectsColorized(ifcObjectIds, [1, 1, 1]);
            this.viewer.scene.setObjectsColorized(objectIds, color);
            this.colorOverrideActive = true;
        } else if (this.colorOverrideActive) {
            this.viewer.scene.setObjectsColorized(ifcObjectIds, [1, 1, 1]);
            this.colorOverrideActive = false;
        }
    }

    /** Creates a clipping plane directly from a previously picked surface. */
    public createSectionAt(
        worldPos: [number, number, number],
        worldNormal?: [number, number, number],
    ): boolean {
        this.createSectionPlane(worldPos, worldNormal);
        this.isCutMode = false;
        return Boolean(this.activeSectionPlaneId);
    }

    /** Shows or hides one loaded model without loading it again. */
    public setPackageVisible(packageId: string, visible: boolean): void {
        const loadedPackage = this.loadedPackages.get(packageId);
        if (!loadedPackage) {
            return;
        }
        loadedPackage.sceneModel.visible = visible;
        loadedPackage.sceneModel.pickable = visible;
    }

    /** Makes one loaded file the only visible scene package. */
    public isolatePackage(packageId: string): void {
        this.loadedPackages.forEach((loadedPackage, id) => {
            const visible = id === packageId;
            loadedPackage.sceneModel.visible = visible;
            loadedPackage.sceneModel.pickable = visible;
        });
    }

    /** Clears the current IFC selection without changing the camera view. */
    public clearSelection(): void {
        if (!this.viewer) return;
        this.viewer.scene.setObjectsSelected(this.viewer.scene.selectedObjectIds, false);
    }

    /** Forces a repaint after overlays or snapshot capture change the page. */
    public refreshScene(): void {
        if (!this.viewer) return;
        this.viewer.scene.render(true);
        window.requestAnimationFrame(() => this.viewer?.scene.render(true));
    }

    /** Applies an IFC metadata filter without affecting point-cloud visibility. */
    public setPropertyFilter(visibleRendererObjectIds: Record<string, string[]>): void {
        if (!this.viewer) {
            return;
        }
        const visibleObjectIds = new Set<string>();
        this.loadedPackages.forEach((loadedPackage, modelId) => {
            if (!loadedPackage.filterable) {
                return;
            }
            (visibleRendererObjectIds[modelId] ?? [])
                .map((rendererObjectId) => `${modelId}#${rendererObjectId}`)
                .filter((objectId) => Boolean(this.viewer?.scene.objects[objectId]))
                .forEach((objectId) => visibleObjectIds.add(objectId));
        });
        this.propertyVisibleObjectIds = visibleObjectIds;
        this.applyElementVisibility();
    }

    /** Removes the active metadata filter and restores each IFC element's visibility. */
    public clearPropertyFilter(): void {
        if (!this.viewer) {
            return;
        }
        this.propertyVisibleObjectIds = null;
        this.applyElementVisibility();
    }

    /** Captures a screenshot first, then removes selection-dependent data from the restorable view. */
    public captureIssueView(): {
        screenshotData: string;
        viewpoint: Record<string, unknown>;
    } {
        if (!this.bcfViewpoints) {
            throw new Error("Viewer is not initialized.");
        }
        const viewpoint = this.bcfViewpoints.getViewpoint({ snapshot: false }) as {
            components?: unknown;
            [key: string]: unknown;
        };
        // Full-resolution PNG screenshots of dense point clouds can be tens of MB.
        // A 1280x720 JPEG remains clear in the issue list and is practical to upload.
        const screenshotData = this.viewer?.getSnapshot({
            format: "jpeg",
            width: 1280,
            height: 720,
        });
        if (!screenshotData) {
            throw new Error("The scene snapshot could not be captured.");
        }

        // Visibility is stored at package level by SymetrIQ. Omitting BCF components also
        // guarantees that reopening an issue never re-selects an IFC object.
        delete viewpoint.components;
        return { screenshotData, viewpoint };
    }

    /** Restores the spatial view without depending on a previously selected IFC object. */
    public restoreIssueView(
        viewpoint: Record<string, unknown>,
        packageVisibility: Record<string, boolean>,
    ): number {
        if (!this.viewer || !this.bcfViewpoints) {
            return 0;
        }
        this.setCutMode(false);
        this.setDistanceMeasurementMode(false);
        this.stopEditingDistanceMeasurement();
        this.viewer.scene.setObjectsSelected(this.viewer.scene.selectedObjectIds, false);
        this.bcfViewpoints.setViewpoint(viewpoint, {
            immediate: true,
            rayCast: false,
            reset: true,
        });
        this.activeSectionPlaneId = null;
        Object.entries(packageVisibility).forEach(([packageId, visible]) => {
            this.setPackageVisible(packageId, visible);
        });
        const clippingPlanes = viewpoint.clipping_planes;
        return Array.isArray(clippingPlanes) ? clippingPlanes.length : 0;
    }

    private createSectionPlane(worldPos: ArrayLike<number>, worldNormal?: ArrayLike<number>): void {
        if (!this.sectionPlanes) {
            return;
        }
        const surfaceDirection = worldNormal
            ? [worldNormal[0], worldNormal[1], worldNormal[2]]
            : this.getCameraDirection();
        // IFC surface normals point toward the side that the current cut
        // workflow traditionally removes. Invert once on creation so a new
        // section immediately reveals the expected interior side.
        const direction = surfaceDirection.map((value) => -value);
        const sectionPlane = this.sectionPlanes.createSectionPlane({
            pos: [worldPos[0], worldPos[1], worldPos[2]],
            dir: direction,
        });
        this.activeSectionPlaneId = sectionPlane.id;
        this.sectionPlanes.showControl(sectionPlane.id);
    }

    private getObjectId(selection: ElementSelection): string {
        return `${selection.modelId}#${selection.rendererObjectId}`;
    }

    private getIfcObjectIds(): string[] {
        return [...this.loadedPackages.values()]
            .filter((loadedPackage) => loadedPackage.filterable)
            .flatMap((loadedPackage) => Object.keys(loadedPackage.sceneModel.objects));
    }

    /** Combines property filtering with the transient Hide/Isolate commands. */
    private applyElementVisibility(): void {
        if (!this.viewer) {
            return;
        }
        const objectIds = this.getIfcObjectIds();
        const propertyAllowedIds = this.propertyVisibleObjectIds
            ? objectIds.filter((objectId) => this.propertyVisibleObjectIds?.has(objectId))
            : objectIds;
        const allowedIds = this.planVisibleObjectIds
            ? propertyAllowedIds.filter((objectId) => this.planVisibleObjectIds?.has(objectId))
            : propertyAllowedIds;
        const visibleIds = this.isolatedObjectId
            ? allowedIds.filter((objectId) => objectId === this.isolatedObjectId)
            : allowedIds.filter((objectId) => !this.manuallyHiddenObjectIds.has(objectId));
        this.viewer.scene.setObjectsVisible(objectIds, false);
        this.viewer.scene.setObjectsVisible(visibleIds, true);
    }

    private getCameraDirection(): [number, number, number] {
        const camera = this.viewer?.camera;
        if (!camera) {
            return [0, 0, -1];
        }
        const direction = [
            camera.look[0] - camera.eye[0],
            camera.look[1] - camera.eye[1],
            camera.look[2] - camera.eye[2],
        ];
        const length = Math.hypot(...direction);
        return length > 0
            ? [direction[0] / length, direction[1] / length, direction[2] / length]
            : [0, 0, -1];
    }

    private exceedsMaximumSceneSpan(): boolean {
        if (!this.viewer) {
            return false;
        }
        const aabb = this.viewer.scene.aabb;
        return this.getMaximumAABBSpan(aabb) > ViewerService.MAX_SCENE_SPAN_METERS;
    }

    private getMaximumAABBSpan(aabb: number[]): number {
        return Math.max(
            aabb[3] - aabb[0],
            aabb[4] - aabb[1],
            aabb[5] - aabb[2],
        );
    }

    private combineAABBs(left: number[], right: number[]): number[] {
        return [
            Math.min(left[0], right[0]),
            Math.min(left[1], right[1]),
            Math.min(left[2], right[2]),
            Math.max(left[3], right[3]),
            Math.max(left[4], right[4]),
            Math.max(left[5], right[5]),
        ];
    }

    private findModelId(entityId: string, modelPackages: ModelPackage[]): string {
        const matchedModel = modelPackages.find((modelPackage) =>
            entityId.startsWith(`${modelPackage.id}#`),
        );
        return matchedModel?.id ?? "point-cloud";
    }

    private getLocalObjectId(entityId: string, modelId: string): string {
        const prefix = `${modelId}#`;
        return entityId.startsWith(prefix)
            ? entityId.slice(prefix.length)
            : entityId;
    }
}
