"use client";

import { Images, LoaderCircle, Play, Upload, X } from "lucide-react";
import { ChangeEvent, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { NumberInput } from "@/components/ui/number-input";
import { Progress } from "@/components/ui/progress";
import {
  cancelVideoFramesTask,
  createVideoFramesTask,
  downloadVideoFramesTask,
  FrameImageFormat,
  FrameMode,
  getVideoFramesTask,
} from "@/lib/video";
import { useUpdateSession } from "@/lib/mutations/session";

const ACCEPTED_VIDEO_TYPES = ["video/mp4", "video/webm", "video/quicktime"];

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function VideoFramesEditor({
  initialFile,
  userId,
  projectId,
  token,
}: {
  initialFile?: File;
  userId?: string;
  projectId?: string;
  token?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const previewUrlRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [startSeconds, setStartSeconds] = useState(0);
  const [endSeconds, setEndSeconds] = useState(0);
  const [mode, setMode] = useState<FrameMode>("fps");
  const [fps, setFps] = useState(1);
  const [everyN, setEveryN] = useState(1);
  const [format, setFormat] = useState<FrameImageFormat>("jpeg");
  const [quality, setQuality] = useState(90);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<{
    frameCount: number;
    zipBytes: number;
    preview: string[];
  } | null>(null);
  const [completedTaskId, setCompletedTaskId] = useState<string | null>(null);
  const [downloadName, setDownloadName] = useState("frames.zip");
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const updateSession = useUpdateSession();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (initialFile) selectFile(initialFile);
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    };
  }, [initialFile]);

  function selectFile(next: File | undefined) {
    if (!next) return;
    if (!ACCEPTED_VIDEO_TYPES.includes(next.type)) {
      setError("Choose an MP4, WebM or MOV video.");
      return;
    }
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    const url = URL.createObjectURL(next);
    previewUrlRef.current = url;
    setFile(next);
    setPreviewUrl(url);
    setError(null);
    setResult(null);
    setCompletedTaskId(null);
  }

  function clearFile() {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = null;
    setFile(null);
    setPreviewUrl(null);
    setDuration(0);
    setStartSeconds(0);
    setEndSeconds(0);
    setResult(null);
    setCompletedTaskId(null);
    setError(null);
  }

  async function process() {
    if (!file || !duration) return;
    if (endSeconds <= startSeconds || endSeconds > duration) {
      setError("The selected interval must be inside the video.");
      return;
    }
    if (mode === "fps" && (fps <= 0 || fps > 120)) {
      setError("Frames per second must be between 0 and 120.");
      return;
    }
    if (mode === "every_n" && (!Number.isInteger(everyN) || everyN <= 0)) {
      setError("Every N frames must be a positive integer.");
      return;
    }
    if (format === "jpeg" && (!Number.isInteger(quality) || quality < 1 || quality > 100)) {
      setError("JPEG quality must be an integer between 1 and 100.");
      return;
    }
    if (!userId || !projectId || !token) {
      setError("Sign in to process the video.");
      return;
    }
    setError(null);
    setResult(null);
    setCompletedTaskId(null);
    setDownloading(false);
    setProgress(0);
    try {
      const task = await createVideoFramesTask(userId, projectId, token, {
        startSeconds,
        endSeconds,
        mode,
        fps: mode === "fps" ? fps : undefined,
        everyN: mode === "every_n" ? everyN : undefined,
        format,
        quality: format === "jpeg" ? quality : undefined,
      });
      setTaskId(task.id);
      timerRef.current = window.setInterval(async () => {
        try {
          const current = await getVideoFramesTask(userId, projectId, token, task.id);
          setProgress(current.progress);
          if (current.status === "completed") {
            if (timerRef.current !== null) window.clearInterval(timerRef.current);
            setResult(current.result ?? null);
            setTaskId(null);
            setCompletedTaskId(task.id);
            setDownloadName(current.downloadName ?? "frames.zip");
            updateSession.mutate({ userId, token });
            void queryClient.invalidateQueries({ queryKey: ["projectResults", userId, projectId] });
          } else if (current.status === "failed" || current.status === "cancelled") {
            if (timerRef.current !== null) window.clearInterval(timerRef.current);
            setTaskId(null);
            setProgress(null);
            setError(current.status === "cancelled" ? "Frame extraction was canceled." : typeof current.error === "string" ? current.error : current.error?.message ?? "Frame extraction failed.");
          }
        } catch {
          setError("Could not update frame extraction progress.");
        }
      }, 1000);
    } catch (requestError: unknown) {
      setProgress(null);
      const response = (
        requestError as {
          response?: { data?: { error?: string | { message?: string } } };
        }
      ).response;
      const apiError = response?.data?.error;
      setError(
        typeof apiError === "string"
          ? apiError
          : apiError?.message ?? "Could not start frame extraction.",
      );
    }
  }

  async function downloadFrames() {
    if (!completedTaskId || !userId || !projectId || !token) return;
    setDownloading(true);
    setError(null);
    try {
      const blob = await downloadVideoFramesTask(
        userId,
        projectId,
        token,
        completedTaskId,
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = downloadName;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      setError("Could not download the frames ZIP.");
    } finally {
      setDownloading(false);
    }
  }

  async function cancel() {
    if (!taskId || !userId || !projectId || !token) return;
    try {
      const task = await cancelVideoFramesTask(userId, projectId, token, taskId);
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      setTaskId(null);
      setProgress(null);
      setError(task.status === "cancelled" ? "Frame extraction was canceled." : "Could not cancel frame extraction.");
      updateSession.mutate({ userId, token });
    } catch {
      setError("Could not cancel frame extraction.");
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Extract frames</h1>
        <p className="mt-2 text-muted-foreground">Create a ZIP with frames from a selected video interval.</p>
      </div>
      {!file ? (
        <Card className="cursor-pointer border-dashed" onClick={() => inputRef.current?.click()}>
          <CardContent className="flex min-h-72 flex-col items-center justify-center gap-4 text-center">
            <Upload className="size-8 text-primary" />
            <p className="font-medium">Upload a video to get started</p>
            <Button type="button" variant="outline">Choose video</Button>
            <input ref={inputRef} type="file" accept={ACCEPTED_VIDEO_TYPES.join(",")} className="hidden" onChange={(event: ChangeEvent<HTMLInputElement>) => { selectFile(event.target.files?.[0]); event.target.value = ""; }} />
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(20rem,0.8fr)]">
          <Card>
            <CardHeader className="flex-row items-start justify-between gap-4">
              <div>
                <CardTitle className="flex items-center gap-2"><Images className="size-5" />{file.name}</CardTitle>
                <CardDescription>Configure the interval and extraction frequency.</CardDescription>
              </div>
              <Button aria-label="Remove video" size="icon" variant="ghost" onClick={clearFile}><X /></Button>
            </CardHeader>
            <CardContent>
              <video
                key={previewUrl ?? "frames-preview"}
                src={previewUrl ?? undefined}
                controls
                className="max-h-[30rem] w-full rounded-lg bg-black"
                onLoadedMetadata={(event) => { const value = event.currentTarget.duration; setDuration(value); setEndSeconds(value); }}
              />
              <p className="mt-3 text-sm text-muted-foreground">Duration: {duration ? formatDuration(duration) : "Reading metadata..."}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Frame extraction</CardTitle><CardDescription>JPEG defaults to quality 90. The original resolution is preserved.</CardDescription></CardHeader>
            <CardContent className="space-y-5">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2"><Label htmlFor="frames-start">Start (seconds)</Label><NumberInput id="frames-start" label="Start" min={0} max={Math.max(0, endSeconds - 0.01)} step={0.1} value={startSeconds} onValueChange={setStartSeconds} /></div>
                <div className="space-y-2"><Label htmlFor="frames-end">End (seconds)</Label><NumberInput id="frames-end" label="End" min={Math.min(duration, startSeconds + 0.01)} max={duration || undefined} step={0.1} value={endSeconds} onValueChange={setEndSeconds} /></div>
              </div>
              <div className="space-y-2"><Label htmlFor="frames-mode">Extraction mode</Label><select id="frames-mode" className="flex h-10 w-full rounded-md border bg-background px-3 text-sm" value={mode} onChange={(event) => setMode(event.target.value as FrameMode)}><option value="fps">Frames per second</option><option value="every_n">Every N frames</option><option value="all">All frames</option></select></div>
              {mode === "fps" && <div className="space-y-2"><Label htmlFor="frames-fps">Frames per second</Label><NumberInput id="frames-fps" label="Frames per second" min={0.01} max={120} step={0.01} value={fps} onValueChange={setFps} /></div>}
              {mode === "every_n" && <div className="space-y-2"><Label htmlFor="frames-every-n">Every N frames</Label><NumberInput id="frames-every-n" label="Every N frames" min={1} step={1} value={everyN} onValueChange={setEveryN} /></div>}
              <div className="space-y-2"><Label htmlFor="frames-format">Image format</Label><select id="frames-format" className="flex h-10 w-full rounded-md border bg-background px-3 text-sm" value={format} onChange={(event) => setFormat(event.target.value as FrameImageFormat)}><option value="jpeg">JPEG</option><option value="png">PNG</option></select></div>
              {format === "jpeg" && <div className="space-y-2"><Label htmlFor="frames-quality">JPEG quality</Label><NumberInput id="frames-quality" label="JPEG quality" min={1} max={100} step={1} value={quality} onValueChange={setQuality} /></div>}
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
              {progress !== null && <div className="space-y-2"><div className="flex justify-between text-sm"><span>{taskId ? "Processing..." : "Processing complete"}</span><span>{progress}%</span></div><Progress value={progress} /></div>}
              {result && <div className="space-y-2 rounded-md border p-3 text-sm"><p className="font-medium">ZIP ready: {result.frameCount} frames ({formatBytes(result.zipBytes)})</p><p className="text-muted-foreground">The first {result.preview.length} frame names are available in the result metadata.</p><ul className="max-h-32 overflow-auto text-xs text-muted-foreground">{result.preview.map((name) => <li key={name}>{name}</li>)}</ul></div>}
              {completedTaskId && <Button className="w-full" variant="outline" onClick={downloadFrames} disabled={downloading}>{downloading ? "Preparing download..." : "Download frames ZIP"}</Button>}
              <Button className="w-full gap-2" onClick={process} disabled={!duration || taskId !== null}><Play className="size-4" />{taskId ? "Processing..." : "Extract frames"}</Button>
              {taskId && <Button className="w-full gap-2" variant="outline" onClick={cancel}><LoaderCircle className="size-4 animate-spin" />Cancel processing</Button>}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
