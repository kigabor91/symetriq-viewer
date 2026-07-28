import type { ModelMetadata } from "../models/ModelMetadata";

export async function loadModelMetadata(src: string): Promise<ModelMetadata> {
    const response = await fetch(src);

    if (!response.ok) {
        throw new Error(`Could not load metadata: ${response.status}`);
    }

    return response.json() as Promise<ModelMetadata>;
}
