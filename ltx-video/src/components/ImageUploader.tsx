import React, { useCallback, useState, useEffect } from 'react'
import { useDropzone } from 'react-dropzone'
import { Upload, X, Image as ImageIcon, RefreshCw, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ImageUploaderProps {
  onImageSelect: (file: File | null) => void
  selectedImage: File | null
}

export function ImageUploader({ onImageSelect, selectedImage }: ImageUploaderProps) {
  const [preview, setPreview] = useState<string | null>(null)

  // Sync preview with selectedImage (handles programmatic changes like "Create video")
  useEffect(() => {
    if (selectedImage) {
      const reader = new FileReader()
      reader.onload = () => {
        setPreview(reader.result as string)
      }
      reader.readAsDataURL(selectedImage)
    } else {
      setPreview(null)
    }
  }, [selectedImage])

  const onDrop = useCallback((acceptedFiles: File[]) => {
    const file = acceptedFiles[0]
    if (file) {
      onImageSelect(file)
      // Preview will be set by the useEffect above
    }
  }, [onImageSelect])

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop,
    accept: {
      'image/png': ['.png'],
      'image/jpeg': ['.jpg', '.jpeg'],
      'image/webp': ['.webp'],
    },
    maxSize: 10 * 1024 * 1024, // 10MB
    multiple: false,
    noClick: !!preview, // Disable click when image is loaded
  })

  const clearImage = (e: React.MouseEvent) => {
    e.stopPropagation()
    onImageSelect(null)
    setPreview(null)
  }

  const replaceImage = (e: React.MouseEvent) => {
    e.stopPropagation()
    open()
  }

  // Truncate filename for display
  const getDisplayName = (file: File | null): string => {
    if (!file) return ''
    const name = file.name
    const maxLength = 28
    if (name.length <= maxLength) return name
    const ext = name.split('.').pop() || ''
    const baseName = name.slice(0, name.length - ext.length - 1)
    const truncatedBase = baseName.slice(0, maxLength - ext.length - 4) // 4 for '...' and '.'
    return `${truncatedBase}...${ext ? '.' + ext : ''}`
  }

  return (
    <div className="w-full">
      <label className="block text-[12px] font-semibold text-zinc-500 mb-2 uppercase leading-4">
        Image
      </label>
      <div
        {...getRootProps()}
        className={cn(
          'relative border border-dashed border-zinc-600 rounded-lg cursor-pointer transition-colors',
          'hover:border-zinc-500',
          isDragActive && 'border-violet-500 bg-violet-500/5',
          preview ? 'p-3' : 'p-6'
        )}
      >
        <input {...getInputProps()} />
        
        {preview && selectedImage ? (
          <div className="flex items-center gap-3">
            {/* Thumbnail */}
            <div className="w-14 h-14 flex-shrink-0 rounded-md overflow-hidden bg-zinc-800">
              <img
                src={preview}
                alt="Selected"
                className="w-full h-full object-cover"
              />
            </div>
            
            {/* Filename */}
            <div className="flex-1 min-w-0">
              <p className="text-sm text-white truncate" title={selectedImage.name}>
                {getDisplayName(selectedImage)}
              </p>
            </div>
            
            {/* Action buttons */}
            <div className="flex items-center gap-1 flex-shrink-0">
              <button
                onClick={clearImage}
                className="p-2 hover:bg-zinc-700 rounded-lg transition-colors"
                title="Remove image"
              >
                <Trash2 className="h-5 w-5 text-zinc-400 hover:text-white" />
              </button>
              <button
                onClick={replaceImage}
                className="p-2 hover:bg-zinc-700 rounded-lg transition-colors"
                title="Replace image"
              >
                <RefreshCw className="h-5 w-5 text-zinc-400 hover:text-white" />
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-4">
            <div className="p-3 bg-zinc-700 rounded-lg">
              {isDragActive ? (
                <Upload className="h-6 w-6 text-violet-400" />
              ) : (
                <ImageIcon className="h-6 w-6 text-zinc-400" />
              )}
            </div>
            <div>
              <p className="text-sm font-medium text-white">
                Drag image file here
              </p>
              <p className="text-sm text-zinc-500">
                Or <span className="text-violet-400 underline">upload a file</span>
              </p>
            </div>
          </div>
        )}
      </div>
      <p className="text-xs text-zinc-500 mt-2">
        png, jpeg, webp. Max size is 10MB
      </p>
    </div>
  )
}
