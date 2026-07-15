import { Viewer as XeokitViewer } from "@xeokit/xeokit-sdk";

export class ViewerService {

    private viewer: XeokitViewer | null = null;

    public initialize(canvas: HTMLCanvasElement): XeokitViewer {

        if (this.viewer) {
            return this.viewer;
        }

        this.viewer = new XeokitViewer({
            canvasElement: canvas,
            transparent: false
        });

        console.log("ViewerService initialized");

        return this.viewer;
    }

    public destroy(): void {

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
}