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
      <label className="block text-xs font-medium text-muted-foreground mb-1.5 uppercase tracking-wide">
        Image
      </label>
      <div
        {...getRootProps()}
        className={cn(
          'relative border-2 border-dashed border-border rounded-lg p-6 cursor-pointer transition-colors',
          'hover:border-muted-foreground',
          isDragActive && 'border-primary bg-primary/5',
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
          <div className="flex flex-col items-center justify-center text-center">
            <div className="p-3 bg-secondary rounded-lg mb-3">
              {isDragActive ? (
                <Upload className="h-6 w-6 text-primary" />
              ) : (
                <ImageIcon className="h-6 w-6 text-muted-foreground" />
              )}
            </div>
            <p className="text-sm font-medium text-foreground">
              Drag image file here
            </p>
            <p className="text-sm text-muted-foreground">
              Or <span className="text-primary underline">upload a file</span>
            </p>
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground mt-1.5">
        png, jpeg, webp. Max size is 10MB
      </p>
    </div>
  )
}
