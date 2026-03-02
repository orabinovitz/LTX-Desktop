import { useCallback } from "react";
import { useDropzone } from "react-dropzone";
import { Upload, Image as ImageIcon, RefreshCw, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface ImageUploaderProps {
  onImageSelect: (path: string | null) => void;
  selectedImage: string | null;
}

export function ImageUploader({
  onImageSelect,
  selectedImage,
}: ImageUploaderProps) {
  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
      const file = acceptedFiles[0];
      if (file) {
        // In Electron, File objects have a .path property with the full filesystem path
        const filePath = (file as File & { path?: string }).path;
        if (filePath) {
          const normalized = filePath.replace(/\\/g, "/");
          const fileUrl = normalized.startsWith("/")
            ? `file://${normalized}`
            : `file:///${normalized}`;
          onImageSelect(fileUrl);
        } else {
          const url = URL.createObjectURL(file);
          onImageSelect(url);
        }
      }
    },
    [onImageSelect],
  );

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop,
    accept: {
      "image/png": [".png"],
      "image/jpeg": [".jpg", ".jpeg"],
      "image/webp": [".webp"],
    },
    maxSize: 10 * 1024 * 1024, // 10MB
    multiple: false,
    noClick: !!selectedImage, // Disable click when image is loaded
  });

  const clearImage = (e: React.MouseEvent) => {
    e.stopPropagation();
    onImageSelect(null);
  };

  const replaceImage = (e: React.MouseEvent) => {
    e.stopPropagation();
    open();
  };

  // Extract and truncate filename from path for display
  const getDisplayName = (path: string | null): string => {
    if (!path) return "";
    // Extract filename from path or URL
    const name =
      path
        .split(/[/\\]/)
        .pop()
        ?.replace(/^file:/, "") || path;
    const decoded = decodeURIComponent(name);
    const maxLength = 28;
    if (decoded.length <= maxLength) return decoded;
    const ext = decoded.split(".").pop() || "";
    const baseName = decoded.slice(0, decoded.length - ext.length - 1);
    const truncatedBase = baseName.slice(0, maxLength - ext.length - 4); // 4 for '...' and '.'
    return `${truncatedBase}...${ext ? "." + ext : ""}`;
  };

  return (
    <div className="w-full">
      <label className="mb-2 block text-[12px] font-semibold uppercase leading-4 text-zinc-500">
        Image
      </label>
      <div
        {...getRootProps()}
        className={cn(
          "relative cursor-pointer rounded-lg border border-dashed border-zinc-600 transition-colors",
          "hover:border-zinc-500",
          isDragActive && "border-blue-500 bg-blue-500/5",
          selectedImage ? "p-3" : "p-6",
        )}
      >
        <input {...getInputProps()} />

        {selectedImage ? (
          <div className="flex items-center gap-3">
            {/* Thumbnail */}
            <div className="h-14 w-14 flex-shrink-0 overflow-hidden rounded-md bg-zinc-800">
              <img
                src={selectedImage}
                alt="Selected"
                className="h-full w-full object-cover"
              />
            </div>

            {/* Filename */}
            <div className="min-w-0 flex-1">
              <p
                className="truncate text-sm text-white"
                title={getDisplayName(selectedImage)}
              >
                {getDisplayName(selectedImage)}
              </p>
            </div>

            {/* Action buttons */}
            <div className="flex flex-shrink-0 items-center gap-1">
              <button
                onClick={clearImage}
                className="rounded-lg p-2 transition-colors hover:bg-zinc-700"
                title="Remove image"
              >
                <Trash2 className="h-5 w-5 text-zinc-400 hover:text-white" />
              </button>
              <button
                onClick={replaceImage}
                className="rounded-lg p-2 transition-colors hover:bg-zinc-700"
                title="Replace image"
              >
                <RefreshCw className="h-5 w-5 text-zinc-400 hover:text-white" />
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-4">
            <div className="rounded-lg bg-zinc-700 p-3">
              {isDragActive ? (
                <Upload className="h-6 w-6 text-blue-400" />
              ) : (
                <ImageIcon className="h-6 w-6 text-zinc-400" />
              )}
            </div>
            <div>
              <p className="text-sm font-medium text-white">
                Drag image file here
              </p>
              <p className="text-sm text-zinc-500">
                Or{" "}
                <span className="text-blue-400 underline">upload a file</span>
              </p>
            </div>
          </div>
        )}
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        png, jpeg, webp. Max size is 10MB
      </p>
    </div>
  );
}
