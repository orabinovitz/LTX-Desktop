import { useState } from "react";
import {
  Download,
  RefreshCw,
  ImageIcon,
  Video,
  Heart,
  Pencil,
  MoreHorizontal,
} from "lucide-react";
import { Button } from "./ui/button";

interface ImageResultProps {
  imageUrl: string | null;
  isGenerating: boolean;
  progress: number;
  statusMessage: string;
  onCreateVideo: () => void;
}

export function ImageResult({
  imageUrl,
  isGenerating,
  progress,
  statusMessage,
  onCreateVideo,
}: ImageResultProps) {
  const [isHovered, setIsHovered] = useState(false);

  const handleDownload = () => {
    if (imageUrl) {
      const a = document.createElement("a");
      a.href = imageUrl;
      a.download = `flux-image-${Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  };

  return (
    <div className="flex h-full w-full flex-col">
      <label className="mb-2 block text-[12px] font-semibold uppercase leading-4 text-zinc-500">
        Result
      </label>

      <div className="relative flex min-h-[400px] flex-1 items-center justify-center overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
        {isGenerating ? (
          <div className="flex flex-col items-center justify-center p-8 text-center">
            <RefreshCw className="mb-4 h-12 w-12 animate-spin text-primary" />
            <p className="mb-2 text-lg font-medium text-foreground">
              Generating Image...
            </p>
            <p className="mb-4 text-sm text-muted-foreground">
              {statusMessage}
            </p>
            <div className="w-64">
              <div className="h-2 overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full bg-primary transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {Math.round(progress)}% complete
              </p>
            </div>
          </div>
        ) : imageUrl ? (
          <div
            className="relative flex h-full w-full items-center justify-center bg-black"
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
          >
            {/* Image display */}
            <img
              src={imageUrl}
              alt="Generated image"
              className="max-h-full max-w-full object-contain"
            />

            {/* Hover overlay - LTX Studio style */}
            <div
              className={`absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/40 transition-opacity duration-200 ${
                isHovered ? "opacity-100" : "opacity-0"
              }`}
            >
              {/* Top toolbar */}
              <div className="absolute left-4 right-4 top-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-9 w-9 rounded-full bg-black/50 text-white backdrop-blur-sm hover:bg-black/70"
                    title="Favorite"
                  >
                    <Heart className="h-4 w-4" />
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={handleDownload}
                    className="h-9 w-9 rounded-full bg-black/50 text-white backdrop-blur-sm hover:bg-black/70"
                    title="Download"
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-9 w-9 rounded-full bg-black/50 text-white backdrop-blur-sm hover:bg-black/70"
                    title="More options"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {/* Center action buttons */}
              <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 transform items-center gap-3">
                <Button
                  variant="ghost"
                  className="flex h-10 items-center gap-2 rounded-full bg-black/50 px-4 text-white backdrop-blur-sm hover:bg-black/70"
                  title="Edit image"
                >
                  <Pencil className="h-4 w-4" />
                  <span className="text-sm font-medium">Edit</span>
                </Button>

                <Button
                  onClick={onCreateVideo}
                  className="flex h-10 items-center gap-2 rounded-full bg-blue-600 px-4 text-white hover:bg-blue-500"
                  title="Create video from this image"
                >
                  <Video className="h-4 w-4" />
                  <span className="text-sm font-medium">Create video</span>
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center text-zinc-500">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-zinc-800">
              <ImageIcon className="h-8 w-8 text-zinc-400" />
            </div>
            <p className="text-sm">Generated image will appear here</p>
          </div>
        )}
      </div>
    </div>
  );
}
