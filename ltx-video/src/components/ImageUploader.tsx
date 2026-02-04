import React, { useCallback, useState } from 'react'
import { useDropzone } from 'react-dropzone'
import { Upload, X, Image as ImageIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ImageUploaderProps {
  onImageSelect: (file: File | null) => void
  selectedImage: File | null
}

export function ImageUploader({ onImageSelect, selectedImage }: ImageUploaderProps) {
  const [preview, setPreview] = useState<string | null>(null)

  const onDrop = useCallback((acceptedFiles: File[]) => {
    const file = acceptedFiles[0]
    if (file) {
      onImageSelect(file)
      const reader = new FileReader()
      reader.onload = () => {
        setPreview(reader.result as string)
      }
      reader.readAsDataURL(file)
    }
  }, [onImageSelect])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'image/png': ['.png'],
      'image/jpeg': ['.jpg', '.jpeg'],
      'image/webp': ['.webp'],
    },
    maxSize: 10 * 1024 * 1024, // 10MB
    multiple: false,
  })

  const clearImage = (e: React.MouseEvent) => {
    e.stopPropagation()
    onImageSelect(null)
    setPreview(null)
  }

  return (
    <div className="w-full">
      <label className="block text-[12px] font-semibold text-zinc-500 mb-2 uppercase leading-4">
        Image
      </label>
      <div
        {...getRootProps()}
        className={cn(
          'relative border border-dashed border-zinc-600 rounded-lg p-6 cursor-pointer transition-colors',
          'hover:border-zinc-500',
          isDragActive && 'border-violet-500 bg-violet-500/5',
          preview && 'p-2'
        )}
      >
        <input {...getInputProps()} />
        
        {preview ? (
          <div className="relative">
            <img
              src={preview}
              alt="Selected"
              className="w-full h-32 object-cover rounded-md"
            />
            <button
              onClick={clearImage}
              className="absolute top-2 right-2 p-1 bg-black/50 rounded-full hover:bg-black/70 transition-colors"
            >
              <X className="h-4 w-4 text-white" />
            </button>
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
