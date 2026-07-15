import { useEffect, useRef } from "react";
import { Viewer as XeokitViewer } from "@xeokit/xeokit-sdk";

function Viewer() {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        if (!canvasRef.current) {
            return;
        }

        const viewer = new XeokitViewer({
            canvasElement: canvasRef.current,
            transparent: false,
        });

        console.log("xeokit viewer created", viewer);

        return () => {
            viewer.destroy();
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