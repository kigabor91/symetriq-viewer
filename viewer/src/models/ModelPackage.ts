export type GeometryFormat = "xkt" | "glb" | "fragments";

export interface SpatialTransform {
    /**
     * World-space reference point for large survey coordinates. Keep this the
     * same for every model and point cloud that belongs to one scene.
     */
    origin?: [number, number, number];
    position?: [number, number, number];
    rotation?: [number, number, number];
    scale?: [number, number, number];
}

export interface ModelPackage {
    id: string;
    displayName?: string;
    geometry: {
        format: GeometryFormat;
        src: string;
    };
    metadata?: {
        src: string;
        format: "json" | "sqlite";
    };
    transform?: SpatialTransform;
}

export interface PointCloudPackage {
    id: string;
    displayName?: string;
    source: {
        /** LAS is recommended for the first integration; LAZ is also supported. */
        format: "las" | "laz";
        src: string;
    };
    /** Load every nth point. 1 keeps every point, 4 keeps every fourth point. */
    pointStride?: number;
    /** Optional converter-created, spatially sampled point-cloud variants. */
    lodSources?: Record<string, {
        format: "las" | "laz";
        src: string;
    }>;
    /** Local LAS East/North/Up to the IFC/XKT render-axis transform. */
    lasTransform?: number[];
    transform?: SpatialTransform;
}

export interface ElementSelection {
    modelId: string;
    /** Stable identifier supplied by the active renderer. */
    rendererObjectId: string;
    /** IFC GlobalId, once a metadata package is available. */
    globalId?: string;
    type?: string;
    name?: string;
}

/** Ephemeral pick information used to position the element action menu. */
export interface ElementActionContext {
    selection: ElementSelection;
    /** Pointer position relative to the viewer canvas, in CSS pixels. */
    canvasPos: [number, number];
    /** Exact point on the picked IFC surface, when available. */
    worldPos?: [number, number, number];
    /** Surface normal at worldPos, when available. */
    worldNormal?: [number, number, number];
}
