"use client";

import { useToast } from "@/hooks/use-toast";
import React, { useState } from "react";
import Dropzone from "react-dropzone";

interface CustomDropzoneProps {
  onDrop: (acceptedFiles: File[]) => void;
  children?: React.ReactNode;
  accept?: Record<string, string[]>;
  onRejected?: (files: File[]) => void;
}

export default function AppDropzone({
  onDrop,
  children,
  accept,
  onRejected,
}: CustomDropzoneProps) {
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const { toast } = useToast();

  return (
    <div className="h-full w-full flex flex-col">
      <Dropzone
        onDrop={onDrop}
        onDragEnter={() => setIsDragging(true)}
        onDragLeave={() => setIsDragging(false)}
        onDropAccepted={() => setIsDragging(false)}
        onDropRejected={(rejectedFiles) => {
          setIsDragging(false);
          onRejected?.(rejectedFiles.map(({ file }) => file));
          toast({
            title: "Invalid file type!",
            description: "Please upload a supported image, video, or .zip file",
            variant: "destructive",
          });
        }}
        accept={accept ?? {
          "image/png": [".png"],
          "image/jpeg": [".jpeg", ".jpg"],
          "application/zip": [".zip"],
          "application/x-zip-compressed": [".zip"],
        }}
      >
        {({ getRootProps, getInputProps }) => (
          <div
            {...getRootProps()}
            className={`flex h-full w-full cursor-pointer items-center justify-center rounded-xl border-2 border-dashed ${
              isDragging
                ? "border-primary bg-primary/10 text-primary"
                : "border-neutral-400 hover:bg-sidebar text-neutral-400"
            } p-4 text-center transition-colors`}
          >
            <input {...getInputProps()} />
            {children}
          </div>
        )}
      </Dropzone>
    </div>
  );
}
