"use client";

import { Film, LoaderCircle, SlidersHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/axios";
import { VideoEditor } from "@/components/video/video-editor";

export function VideoProjectView({
  userId,
  projectId,
  token,
}: {
  userId: string;
  projectId: string;
  token: string;
}) {
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let url: string | null = null;
    api
      .get(`/projects/${userId}/${projectId}/video`, {
        headers: { Authorization: `Bearer ${token}` },
        responseType: "blob",
      })
      .then((response) => {
        const fileName = response.headers["content-disposition"]
          ?.match(/filename="?([^"]+)"?/)?.[1] ?? "video-original.mp4";
        const file = new File([response.data], fileName, {
          type: response.data.type || "video/mp4",
        });
        setVideoFile(file);
        url = URL.createObjectURL(file);
        setVideoUrl(url);
      })
      .catch(() => setError("Could not load the video for this project."));
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [projectId, token, userId]);

  if (editing && videoFile) {
    return (
      <div className="h-full overflow-y-auto p-8">
        <Button variant="outline" className="mb-6" onClick={() => setEditing(false)}>
          Back to project
        </Button>
        <VideoEditor
          initialFile={videoFile}
          userId={userId}
          projectId={projectId}
          token={token}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center p-8">
      <Card className="w-full max-w-4xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Film className="size-5" />
            Video editing
          </CardTitle>
          <CardDescription>
            The original video is preserved. Choose an operation to create a processed copy.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {videoUrl ? (
            <video className="max-h-[55vh] w-full rounded-lg bg-black" controls src={videoUrl}>
              Your browser does not support video playback.
            </video>
          ) : error ? (
            <p className="text-destructive">{error}</p>
          ) : (
            <div className="flex items-center gap-2 text-muted-foreground">
              <LoaderCircle className="animate-spin" />
              Loading video...
            </div>
          )}
          <Button
            disabled={!videoFile}
            onClick={() => setEditing(true)}
            className="inline-flex gap-2"
          >
            <SlidersHorizontal className="size-4" />
            Process video
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
