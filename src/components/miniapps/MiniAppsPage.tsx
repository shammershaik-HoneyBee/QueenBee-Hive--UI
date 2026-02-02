import { useState } from "react";
import {
  CloudSun,
  Camera,
  Mic,
  Music,
  Settings,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import "./MiniAppsPage.css";
import { CameraApp } from "./camera/CameraApp";

interface MiniApp {
  id: string;
  name: string;
  icon: LucideIcon;
  color: string;
  bgColor: string;
}

const miniApps: MiniApp[] = [
  {
    id: "weather",
    name: "Weather",
    icon: CloudSun,
    color: "text-sky-400",
    bgColor: "from-sky-500/20 to-sky-600/30",
  },
  {
    id: "camera",
    name: "Camera",
    icon: Camera,
    color: "text-rose-400",
    bgColor: "from-rose-500/20 to-rose-600/30",
  },
  {
    id: "recorder",
    name: "Recorder",
    icon: Mic,
    color: "text-amber-400",
    bgColor: "from-amber-500/20 to-amber-600/30",
  },
  {
    id: "music",
    name: "Music",
    icon: Music,
    color: "text-emerald-400",
    bgColor: "from-emerald-500/20 to-emerald-600/30",
  },
  {
    id: "settings",
    name: "Settings",
    icon: Settings,
    color: "text-zinc-400",
    bgColor: "from-zinc-500/20 to-zinc-600/30",
  },
];

// Arrange apps into honeycomb rows: [2, 3] pattern for tessellation
const honeycombRows: MiniApp[][] = [
  [miniApps[0], miniApps[1]],           // Row 1: 2 apps
  [miniApps[2], miniApps[3], miniApps[4]], // Row 2: 3 apps (offset)
];

interface MiniAppsPageProps {
  onClose: () => void;
}

export function MiniAppsPage({ onClose }: MiniAppsPageProps) {
  const [activeApp, setActiveApp] = useState<string | null>(null);
  const [openApp, setOpenApp] = useState<string | null>(null);

  const handleAppClick = (appId: string) => {
    setActiveApp(appId);
    // Open the app
    setOpenApp(appId);
    console.log(`Opening app: ${appId}`);
  };

  const handleCloseApp = () => {
    setOpenApp(null);
    setActiveApp(null);
  };

  // Render the active mini app
  if (openApp === "camera") {
    return <CameraApp onClose={handleCloseApp} />;
  }

  // TODO: Add other mini apps here
  // if (openApp === "weather") return <WeatherApp onClose={handleCloseApp} />;
  // if (openApp === "recorder") return <RecorderApp onClose={handleCloseApp} />;
  // if (openApp === "music") return <MusicApp onClose={handleCloseApp} />;
  // if (openApp === "settings") return <SettingsApp onClose={handleCloseApp} />;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-gradient-to-b from-zinc-900 via-zinc-950 to-black">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4">
        <h1 className="text-2xl font-semibold text-white">
          <span className="text-amber-500">Honey</span>bee Apps
        </h1>
        <button
          onClick={onClose}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-zinc-800/80 text-zinc-400 transition-all hover:bg-zinc-700 hover:text-white active:scale-95"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Hexagonal Honeycomb Grid */}
      <div className="flex flex-1 items-center justify-center px-4">
        <div className="honeycomb-grid">
          {honeycombRows.map((row, rowIndex) => (
            <div key={rowIndex} className="honeycomb-row">
              {row.map((app, appIndex) => (
                <HexagonTile
                  key={app.id}
                  app={app}
                  index={rowIndex * 3 + appIndex}
                  isActive={activeApp === app.id}
                  onClick={() => handleAppClick(app.id)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Footer hint */}
      <div className="pb-8 text-center text-sm text-zinc-500">
        Tap an app to open • Swipe down to return
      </div>
    </div>
  );
}

interface HexagonTileProps {
  app: MiniApp;
  index: number;
  isActive: boolean;
  onClick: () => void;
}

function HexagonTile({ app, index, isActive, onClick }: HexagonTileProps) {
  const Icon = app.icon;

  return (
    <button
      onClick={onClick}
      className={cn(
        "hexagon-tile group",
        "relative flex flex-col items-center justify-center",
        "transition-all duration-300 ease-out",
        "hover:scale-110 hover:z-10",
        "active:scale-95",
        isActive && "scale-105 z-10"
      )}
      style={{
        animationDelay: `${index * 100}ms`,
      }}
    >
      {/* Hexagon Shape with Icon and Text inside */}
      <div
        className={cn(
          "hexagon",
          "flex flex-col items-center justify-center gap-1",
          "bg-gradient-to-br",
          app.bgColor,
          "border border-white/10",
          "shadow-lg shadow-black/20",
          "transition-all duration-300",
          "group-hover:border-white/20 group-hover:shadow-xl",
          isActive && "border-amber-500/50 shadow-amber-500/20"
        )}
      >
        <Icon
          className={cn(
            "h-10 w-10 transition-all duration-300",
            app.color,
            "group-hover:scale-110",
            "drop-shadow-lg"
          )}
        />
        {/* App Name inside hexagon */}
        <span
          className={cn(
            "text-xs font-medium text-zinc-300 mt-1",
            "transition-colors duration-300",
            "group-hover:text-white"
          )}
        >
          {app.name}
        </span>
      </div>
    </button>
  );
}

export default MiniAppsPage;
