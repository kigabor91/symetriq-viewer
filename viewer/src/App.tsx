import { useEffect, useState } from "react";
import "./App.css";
import { ProjectDashboard } from "./components/ProjectDashboard";
import { ProjectDetails } from "./components/ProjectDetails";
import { ProjectScene } from "./components/ProjectScene";

function navigate(path: string): void {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
}

function App() {
    const [path, setPath] = useState(window.location.pathname);

    useEffect(() => {
        const onLocationChanged = () => setPath(window.location.pathname);
        window.addEventListener("popstate", onLocationChanged);
        return () => window.removeEventListener("popstate", onLocationChanged);
    }, []);

    const sceneMatch = path.match(/^\/projects\/([^/]+)\/scene$/);
    if (sceneMatch) {
        const projectId = decodeURIComponent(sceneMatch[1]);
        return (
            <ProjectScene
                projectId={projectId}
                onBack={() => navigate(`/projects/${projectId}`)}
            />
        );
    }

    const projectMatch = path.match(/^\/projects\/([^/]+)$/);
    if (projectMatch) {
        const projectId = decodeURIComponent(projectMatch[1]);
        return (
            <ProjectDetails
                projectId={projectId}
                onBack={() => navigate("/")}
                onOpenScene={() => navigate(`/projects/${projectId}/scene`)}
            />
        );
    }

    return <ProjectDashboard onOpenProject={(projectId) => navigate(`/projects/${projectId}`)} />;
}

export default App;
