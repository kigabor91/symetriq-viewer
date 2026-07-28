import type {
    ElementActionContext,
    ElementSelection,
    ModelPackage,
    PointCloudPackage,
} from "../models/ModelPackage";

export interface ViewerAdapterEvents {
    onModelLoaded?: () => void;
    onModelError?: (message: string) => void;
    onModelAreaExceeded?: (limitMeters: number) => void;
    onSelectionChanged?: (selection: ElementSelection | null) => void;
    onElementActionContext?: (context: ElementActionContext | null) => void;
    onCutPlaneCreated?: () => void;
    onDistanceMeasurementCreated?: () => void;
}

export interface ViewerAdapter {
    initialize(
        canvas: HTMLCanvasElement,
        modelPackages: ModelPackage[],
        pointCloudPackages: PointCloudPackage[],
        events: ViewerAdapterEvents,
    ): void;
    destroy(): void;
}
