import { useEffect, useRef } from "react";
import { ViewerService } from "../services/ViewerService";

function Viewer() {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        if (!canvasRef.current) {
            return;
        }

        const viewerService = new ViewerService();

        viewerService.initialize(canvasRef.current);

        return () => {
            viewerService.destroy();
        };
    }, []);

    return (
        <canvas
            ref={canvasRef}
            style={{
                width: "100%",
                height: "100%",
                display: "block",
            }}
        />
    );
}

export default Viewer;