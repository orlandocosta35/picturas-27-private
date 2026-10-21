"use client";
import { useState, useEffect } from "react";
import { VideoTrimEditor } from "@/components/video/video-trim-editor";
export default function Page() {
  const [context, setContext] = useState<{
    userId: string;
    projectId: string;
    token: string;
  }>();
  const [file, setFile] = useState<File>();
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    Promise.all([
      fetch("/context.json").then((r) => r.json()),
      fetch("/fixture.mp4").then((r) => r.blob()),
    ]).then(([c, b]) => {
      setContext(c);
      setFile(new File([b], "sample.mp4", { type: "video/mp4" }));
    });
  }, []);
  return context && file ? (
    <main className="p-6">
      <button onClick={() => setVisible((v) => !v)}>
        {visible ? "Sair do editor" : "Voltar ao editor"}
      </button>
      {visible && (
        <VideoTrimEditor initialFile={file} {...context} onResize={() => {}} />
      )}
    </main>
  ) : (
    <p>A carregar...</p>
  );
}
