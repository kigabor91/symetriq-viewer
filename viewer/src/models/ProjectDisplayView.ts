export type DisplayMode = "shaded" | "xray";

export interface ProjectDisplayView {
    id: string;
    name: string;
    mode: DisplayMode;
    opacity: number;
    colorOverride?: {
        propertyKey: string;
        values: string[];
        color: string;
    };
    createdAt: string;
}
