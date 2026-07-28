import { useEffect, useRef } from "react";
import "pannellum/build/pannellum.css";
import "pannellum/build/pannellum.js";

export interface PanoramaStation {
    id: string;
    name: string;
    sourceData3DGuid: string;
    position: [number, number, number];
    rotation: [number, number, number, number];
    faces: string[];
    sourceName?: string;
}

declare global {
    interface Window {
        pannellum?: {
            viewer: (container: HTMLElement, configuration: Record<string, unknown>) => {
                destroy: () => void;
            };
        };
    }
}

interface PanoramaOverlayProps {
    station: PanoramaStation;
    onClose: () => void;
}

/** Opens Leica's six JPEG faces directly as a cubemap panorama. */
export function PanoramaOverlay({ station, onClose }: PanoramaOverlayProps) {
    const hostRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const host = hostRef.current;
        if (!host || !window.pannellum || station.faces.length !== 6) return;
        const panorama = window.pannellum.viewer(host, {
            type: "cubemap",
            cubeMap: station.faces,
            autoLoad: true,
            showControls: true,
            hfov: 100,
            minHfov: 40,
            maxHfov: 120,
        });
        return () => panorama.destroy();
    }, [station]);

    return (
        <section className="panorama-overlay" aria-label="Panorama viewer">
            <button
                type="button"
                className="panorama-close-button"
                aria-label="Close panorama"
                title="Close panorama"
                onClick={onClose}
            >
                ×
            </button>
            {station.faces.length === 6
                ? <div ref={hostRef} className="panorama-host" />
                : <p className="panorama-error">This scanner station does not contain all six panorama faces.</p>}
        </section>
    );
}
