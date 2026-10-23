"use client";
import { useState, useEffect } from "react";
import { VideoEditor } from "@/components/video/video-editor";
export default function Page() {
  const [context, setContext] = useState<{
    userId: string;
    projectId: string;
    token: string;
  }>();
  const [file, setFile] = useState<File>();
  useEffect(() => {
    Promise.all([
      fetch("/audio-context.json").then((r) => r.json()),
      fetch("/fixture.mp4").then((r) => r.blob()),
    ]).then(([c, blob]) => {
      setContext(c);
      setFile(new File([blob], "sample.mp4", { type: "video/mp4" }));
    });
  }, []);
  return context && file ? (
    <main className="p-6">
      <VideoEditor initialFile={file} {...context} />
    </main>
  ) : (
    <p>Loading…</p>
  );
}
