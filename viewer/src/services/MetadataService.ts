import type { ModelMetadata } from "../models/ModelMetadata";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Converts external metadata into the minimum shape the Viewer can safely use.
 *
 * IFC packages already provide the full ModelMetadata schema. Revit Publish
 * metadata is currently a smaller, different schema, so unsupported fields
 * deliberately become empty rather than preventing the XKT scene from rendering.
 */
export function normalizeModelMetadata(value: unknown): ModelMetadata {
    const metadata = isRecord(value) ? value : {};
    return {
        version: typeof metadata.version === "number" ? metadata.version : 2,
        elements: isRecord(metadata.elements) ? metadata.elements as ModelMetadata["elements"] : {},
        propertySets: isRecord(metadata.propertySets) ? metadata.propertySets as ModelMetadata["propertySets"] : {},
        levels: Array.isArray(metadata.levels) ? metadata.levels as ModelMetadata["levels"] : [],
    };
}

export async function loadModelMetadata(src: string): Promise<ModelMetadata> {
    const response = await fetch(src);

    if (!response.ok) {
        throw new Error(`Could not load metadata: ${response.status}`);
    }

    return normalizeModelMetadata(await response.json() as unknown);
}
