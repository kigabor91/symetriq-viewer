export interface ModelProperty {
    name: string;
    value: unknown;
    type?: string;
    description?: string;
}

export interface ModelPropertySet {
    id: string;
    name: string;
    type: string;
    properties: ModelProperty[];
}

export interface ModelElement {
    globalId: string;
    type: string;
    name: string;
    parentId?: string;
    propertySetIds: string[];
    /** Lightweight identity projection for published Revit models. */
    identity?: {
        logicalElementId: string;
        revitUniqueId: string;
        category: string;
        family: string;
        type: string;
    };
    /** Canonical Hub reference; never inferred from an XKT node name. */
    propertyStore?: { renderObjectId: string };
}

export interface ModelLevel {
    id: string;
    name: string;
    elevation: number;
    source: "ifc" | string;
    method: "explicit" | "inferred" | "manual" | string;
}

export interface ModelMetadata {
    version: number;
    elements: Record<string, ModelElement>;
    propertySets: Record<string, ModelPropertySet>;
    levels?: ModelLevel[];
}
