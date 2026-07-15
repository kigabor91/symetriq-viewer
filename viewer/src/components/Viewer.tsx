import { useEffect, useRef } from "react";

function Viewer() {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        console.log("Viewer initialized");
    }, []);

    return (
        <canvas
            ref={canvasRef}
            style={{
                width: "100%",
                height: "100%",
                display: "block",
                backgroundColor: "#202124",
            }}
        />
    );
}

export default Viewer;