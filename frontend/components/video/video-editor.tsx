"use client";

import { VideoEditorHeader } from "./video-editor-header";

import { NumberInput } from "@/components/ui/number-input";

import {
  Film,
  LoaderCircle,
  Play,
  Upload,
  X,
} from "lucide-react";
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
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  cancelVideoResizeTask,
  createVideoResizeTask,
  downloadVideoResizeTask,
  getVideoResizeTask,
  ResizeMode,
  VideoOutputFormat,
} from "@/lib/video";
import { VideoAudioEditor } from "./video-audio-editor";
import { VideoConcatEditor } from "./video-concat-editor";
import { VideoOperation, VideoOperationTabs } from "./video-operation-tabs";
import { VideoTrimEditor } from "./video-trim-editor";
import { VideoFramesEditor } from "./video-frames-editor";
import { VideoSavedResults } from "./video-saved-results";
import { useUpdateSession } from "@/lib/mutations/session";

type VideoMetadata = {
  duration: number;
  width: number;
  height: number;
};

const RESOLUTION_PRESETS = [
  { label: "Original", width: null, height: null },
  { label: "Portrait 3:4", width: 1080, height: 1440 },
  { label: "Portrait 4:5", width: 1080, height: 1350 },
  { label: "Vertical 9:16", width: 1080, height: 1920 },
] as const;

const RESIZE_MODES: Array<{ value: ResizeMode; label: string; description: string }> = [
  { value: "contain", label: "Letterbox", description: "Keeps the entire video." },
  { value: "cover", label: "Crop to fill", description: "Fills the area and crops the edges." },
  { value: "stretch", label: "Stretch", description: "May distort the image." },
];

const OUTPUT_FORMATS: Array<{ value: VideoOutputFormat; label: string }> = [
  { value: "mp4", label: "MP4 (H.264 + AAC)" },
  { value: "webm", label: "WebM (VP9 + Opus)" },
];

const ACCEPTED_VIDEO_TYPES = ["video/mp4", "video/webm", "video/quicktime"];

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds)) return "--:--";
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function aspectRatio(width: number, height: number) {
  return width / height;
}

function isSameAspectRatio(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
) {
  return Math.abs(
    aspectRatio(sourceWidth, sourceHeight) -
      aspectRatio(targetWidth, targetHeight),
  ) < 0.01;
}

export function VideoEditor({
  initialFile,
  userId,
  projectId,
  token,
}: {
  initialFile?: File;
  userId?: string;
  projectId?: string;
  token?: string;
} = {}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const previewUrlRef = useRef<string | null>(null);
  const progressTimerRef = useRef<number | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<VideoMetadata | null>(null);
  const [operation, setOperation] = useState<VideoOperation>("trim");
  const [startSeconds, setStartSeconds] = useState(0);
  const [endSeconds, setEndSeconds] = useState(0);
  const [width, setWidth] = useState(1280);
  const [height, setHeight] = useState(720);
  const [resizeMode, setResizeMode] = useState<ResizeMode>("contain");
  const [outputFormat, setOutputFormat] = useState<VideoOutputFormat>("mp4");
  const [customResolution, setCustomResolution] = useState(false);
  const [upscaleConfirmationOpen, setUpscaleConfirmationOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Non-blocking warnings from the service, e.g. ignored audio tracks.
  const [warnings, setWarnings] = useState<string[]>([]);
  const [progress, setProgress] = useState<number | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const communicationFailuresRef = useRef(0);
  const updateSession = useUpdateSession();
  const queryClient = useQueryClient();

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      if (progressTimerRef.current !== null) {
        window.clearInterval(progressTimerRef.current);
      }
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    };
  }, [downloadUrl]);

  useEffect(() => {
    if (metadata) setEndSeconds(metadata.duration);
  }, [metadata]);

  const handleFile = (selectedFile: File | undefined) => {
    if (!selectedFile) return;
    if (!ACCEPTED_VIDEO_TYPES.includes(selectedFile.type)) {
      setError("Choose an MP4, WebM or MOV video.");
      return;
    }

    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    const nextPreviewUrl = URL.createObjectURL(selectedFile);
    previewUrlRef.current = nextPreviewUrl;
    setFile(selectedFile);
    setPreviewUrl(nextPreviewUrl);
    setMetadata(null);
    setProgress(null);
    setError(null);
  };

  useEffect(() => {
    if (initialFile) handleFile(initialFile);
  }, [initialFile]);

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    handleFile(event.target.files?.[0]);
    event.target.value = "";
  };

  const clearFile = () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = null;
    setFile(null);
    setPreviewUrl(null);
    setMetadata(null);
    setProgress(null);
    setError(null);
  };

  const handleMetadata = (video: HTMLVideoElement) => {
    const nextMetadata = {
      duration: video.duration,
      width: video.videoWidth,
      height: video.videoHeight,
    };
    setMetadata(nextMetadata);
    setEndSeconds(nextMetadata.duration);
    setWidth(nextMetadata.width);
    setHeight(nextMetadata.height);
  };

  const selectResolution = (nextWidth: number | null, nextHeight: number | null) => {
    if (nextWidth === null || nextHeight === null) {
      setCustomResolution(false);
      setWidth(metadata?.width ?? width);
      setHeight(metadata?.height ?? height);
      return;
    }
    setCustomResolution(false);
    setWidth(nextWidth);
    setHeight(nextHeight);
  };

  const handleProcess = (upscaleConfirmed = false) => {
    if (!file || !metadata) return;
    if (operation === "trim" && endSeconds <= startSeconds) {
      setError("The trim end time must be after the start time.");
      return;
    }
    if (operation !== "resize") {
      setError("Select Resize to use this operation.");
      return;
    }
    if (
      (!Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width < 64 ||
        height < 64 ||
        width % 2 !== 0 ||
        height % 2 !== 0)
    ) {
      setError("Resolution must use even integers of at least 64 px.");
      return;
    }

    const sourceFormat: VideoOutputFormat =
      file.type === "video/webm" ? "webm" : "mp4";
    const hasNoChanges =
      width === metadata.width &&
      height === metadata.height &&
      outputFormat === sourceFormat;
    if (hasNoChanges) {
      setError(
        "The selected settings do not change the video. Choose a different resolution or format.",
      );
      return;
    }

    const isUpscaling =
      width > metadata.width || height > metadata.height;
    if (isUpscaling && !upscaleConfirmed) {
      setError(null);
      setUpscaleConfirmationOpen(true);
      return;
    }

    if (!userId || !projectId || !token) {
      setError("Sign in to process the video.");
      return;
    }

    setError(null);
    setWarnings([]);
    setProgress(0);
    setDownloadUrl(null);
    createVideoResizeTask(userId, projectId, token, file, {
      width,
      height,
      resizeMode,
      outputFormat,
    })
      .then((task) => {
        setTaskId(task.id);
        setWarnings(task.inputMetadata?.warnings ?? []);
        communicationFailuresRef.current = 0;
        progressTimerRef.current = window.setInterval(async () => {
          try {
            const current = await getVideoResizeTask(userId, projectId, token, task.id);
            communicationFailuresRef.current = 0;
            setError(null);
            setProgress(current.progress);
            if (current.status === "completed") {
              if (progressTimerRef.current !== null) window.clearInterval(progressTimerRef.current);
              const result = await downloadVideoResizeTask(userId, projectId, token, task.id);
              setDownloadUrl(URL.createObjectURL(result));
              setTaskId(null);
              updateSession.mutate({ userId, token });
              for (const queryKey of [
                ["project", userId, projectId],
                ["projectResults", userId, projectId],
                ["projects", userId],
              ]) {
                void queryClient.invalidateQueries({ queryKey });
              }
            } else if (current.status === "failed" || current.status === "cancelled") {
              if (progressTimerRef.current !== null) window.clearInterval(progressTimerRef.current);
              setTaskId(null);
              setProgress(null);
              setError(
                current.status === "cancelled"
                  ? "Video processing was canceled."
                  : typeof current.error === "string"
                    ? current.error
                    : current.error?.message ?? "Video processing failed.",
              );
            }
          } catch {
            communicationFailuresRef.current += 1;
            if (communicationFailuresRef.current >= 5) {
              if (progressTimerRef.current !== null) window.clearInterval(progressTimerRef.current);
              setError("Could not update progress. Please try again.");
            } else {
              setError("Connection interrupted. Retrying...");
            }
          }
        }, 1000);
      })
      .catch((error) => {
        setProgress(null);
        setTaskId(null);
        setError(
          error?.response?.status === 701 ||
          error?.response?.data?.error?.code === "QUOTA_EXCEEDED"
            ? "You have reached your daily operation limit."
            : error?.response?.data?.error?.message ??
              "Could not start video processing.",
        );
      });
  };

  const cancelProcessing = async () => {
    if (!taskId || !userId || !projectId || !token) return;
    try {
      const task = await cancelVideoResizeTask(userId, projectId, token, taskId);
      if (progressTimerRef.current !== null) {
        window.clearInterval(progressTimerRef.current);
      }
      setError(
        task.status === "cancelled"
          ? "Video processing was canceled."
          : typeof task.error === "string"
            ? task.error
            : task.error?.message ?? null,
      );
      setTaskId(null);
      setProgress(null);
      updateSession.mutate({ userId, token });
    } catch {
      setError("Could not cancel video processing.");
    }
  };

  const maxDuration = metadata?.duration ?? 1;
  const aspectRatioChanged =
    metadata !== null &&
    !isSameAspectRatio(metadata.width, metadata.height, width, height);

  const legacyEditor = (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <VideoEditorHeader
          title="Resize video"
          description="Select a video and configure the output resolution, resize mode and format."
        />

      {!file ? (
        <Card
          className="cursor-pointer border-dashed transition-colors hover:border-primary hover:bg-muted/30"
          onClick={() => inputRef.current?.click()}
        >
          <CardContent className="flex min-h-72 flex-col items-center justify-center gap-4 text-center">
            <div className="rounded-full bg-primary/10 p-4 text-primary">
              <Upload className="size-8" />
            </div>
            <div>
              <p className="font-medium">Upload a video to get started</p>
              <p className="mt-1 text-sm text-muted-foreground">
                MP4, WebM or MOV
              </p>
            </div>
            <Button type="button" variant="outline">
              Choose video
            </Button>
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPTED_VIDEO_TYPES.join(",")}
              className="hidden"
              onChange={handleInputChange}
            />
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(20rem,0.8fr)]">
          <Card>
            <CardHeader className="flex-row items-start justify-between gap-4">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Film className="size-5" />
                  {file.name}
                </CardTitle>
                <CardDescription className="mt-2">
                  {formatFileSize(file.size)} ·{" "}
                  {metadata
                    ? `${metadata.width} × ${metadata.height} · ${formatDuration(metadata.duration)}`
                    : "Reading metadata..."}
                </CardDescription>
              </div>
              <Button
                aria-label="Remove video"
                size="icon"
                variant="ghost"
                onClick={clearFile}
              >
                <X />
              </Button>
            </CardHeader>
            <CardContent>
              <video
                key={previewUrl ?? "video-preview"}
                src={previewUrl ?? undefined}
                controls
                className="max-h-[30rem] w-full rounded-lg bg-black"
                onLoadedMetadata={(event) => handleMetadata(event.currentTarget)}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Resize</CardTitle>
              <CardDescription>
                Choose the resolution, resize mode and output format.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {operation === "trim" ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="trim-start">Start (seconds)</Label>
                      <NumberInput
                        id="trim-start"
                        label="Trim start"
                        min={0}
                        max={Math.max(0, endSeconds - 0.1)}
                        step={0.1}
                        value={startSeconds}
                        onValueChange={(value) =>
                          setStartSeconds(value)
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="trim-end">End (seconds)</Label>
                      <NumberInput
                        id="trim-end"
                        label="Trim end"
                        min={Math.min(maxDuration, startSeconds + 0.1)}
                        max={maxDuration}
                        step={0.1}
                        value={endSeconds}
                        onValueChange={(value) =>
                          setEndSeconds(value)
                        }
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <Label htmlFor="trim-range">Intervalo</Label>
                      <span className="text-muted-foreground">
                        {formatDuration(Math.max(0, endSeconds - startSeconds))}
                      </span>
                    </div>
                    <input
                      id="trim-range"
                      type="range"
                      min={0}
                      max={maxDuration}
                      step={0.1}
                      value={endSeconds}
                      onChange={(event) =>
                        setEndSeconds(Number(event.target.value))
                      }
                      className="w-full accent-primary"
                    />
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label>Resolution preset</Label>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {RESOLUTION_PRESETS.map((preset) => {
                        const isSelected =
                          preset.width === null
                            ? !customResolution &&
                              metadata?.width === width &&
                              metadata?.height === height
                            : !customResolution &&
                              width === preset.width &&
                              height === preset.height;

                        return (
                          <Button
                            key={preset.label}
                            type="button"
                            variant={isSelected ? "default" : "outline"}
                            className="h-auto min-h-14 flex-col gap-0.5 py-2 text-center"
                            onClick={() => selectResolution(preset.width, preset.height)}
                          >
                            {preset.label}
                            {preset.width !== null && (
                              <span className="text-xs font-normal opacity-75">
                                {preset.width}×{preset.height}
                              </span>
                            )}
                          </Button>
                        );
                      })}
                      <Button
                        type="button"
                        variant={customResolution ? "default" : "outline"}
                        className="h-auto min-h-14 flex-col gap-0.5 py-2 text-center"
                        onClick={() => setCustomResolution(true)}
                      >
                        Custom
                        <span className="text-xs font-normal opacity-75">
                          Up to 3840×2160
                        </span>
                      </Button>
                    </div>
                  </div>

                  {customResolution && (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-2">
                        <Label htmlFor="resize-width">Width (px)</Label>
                        <NumberInput
                          id="resize-width"
                          label="Width"
                          min={64}
                          step={2}
                          value={width}
                          onValueChange={(value) => setWidth(value)}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="resize-height">Height (px)</Label>
                        <NumberInput
                          id="resize-height"
                          label="Height"
                          min={64}
                          step={2}
                          value={height}
                          onValueChange={(value) => setHeight(value)}
                        />
                      </div>
                    </div>
                  )}

                  <div className="space-y-2">
                    <Label>Resize mode</Label>
                    <div className="grid gap-2">
                      {RESIZE_MODES.map((mode) => (
                        <Button
                          key={mode.value}
                          type="button"
                          variant={resizeMode === mode.value ? "default" : "outline"}
                          className="h-auto justify-start py-2 text-left"
                          onClick={() => setResizeMode(mode.value)}
                        >
                          <span>
                            <span className="block">{mode.label}</span>
                            <span className="block text-xs font-normal opacity-75">
                              {mode.description}
                            </span>
                          </span>
                        </Button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="resize-format">Output format</Label>
                    <select
                      id="resize-format"
                      value={outputFormat}
                      onChange={(event) =>
                        setOutputFormat(event.target.value as VideoOutputFormat)
                      }
                      className="flex h-10 w-full rounded-md border bg-background px-3 py-2 text-sm"
                    >
                      {OUTPUT_FORMATS.map((format) => (
                        <option key={format.value} value={format.value}>
                          {format.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <p className="text-sm text-muted-foreground">
                    Settings: {width} × {height} ·{" "}
                    {RESIZE_MODES.find((mode) => mode.value === resizeMode)?.label} ·{" "}
                    {outputFormat.toUpperCase()}
                  </p>

                  {aspectRatioChanged && (
                    <Alert>
                      <AlertTitle>Different aspect ratio</AlertTitle>
                      <AlertDescription>
                        The original video has a different aspect ratio from the output resolution. Choose a resize mode: letterbox preserves all content, crop to fill may crop the edges, and stretch may distort the image.
                      </AlertDescription>
                    </Alert>
                  )}
                </div>
              )}

              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}

              {warnings.map((warning) => (
                <p
                  key={warning}
                  role="status"
                  className="text-sm text-amber-600 dark:text-amber-400"
                >
                  {warning}
                </p>
              ))}

              {progress !== null && (
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span>
                      {progress === 100
                        ? "Processing complete"
                        : progress >= 99
                          ? "Saving the result..."
                          : "Processing..."}
                    </span>
                    <span>{progress}%</span>
                  </div>
                  <Progress value={progress} />
                </div>
              )}

              <Button
                className="w-full gap-2"
                onClick={() => handleProcess()}
                disabled={!metadata || taskId !== null || progress !== null && progress < 100}
              >
                {progress !== null && progress < 100 ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <Play className="size-4" />
                )}
                {taskId !== null ? "Processing..." : "Process video"}
              </Button>
              {taskId && progress !== null && progress < 100 && (
                <Button
                  className="w-full"
                  variant="outline"
                  onClick={cancelProcessing}
                >
                  Cancel processing
                </Button>
              )}
              {downloadUrl && (
                <a
                  className="inline-flex w-full items-center justify-center rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
                  href={downloadUrl}
                  download={`resized-${file.name}`}
                >
                  Download processed video
                </a>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {error && !file && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
  // Each operation has its own screen; the tabs above them are the only navigation.
  const screen =
    operation === "concat" ? (
      <VideoConcatEditor userId={userId} projectId={projectId} token={token} />
    ) : operation === "audio" ? (
      <VideoAudioEditor initialFile={initialFile} userId={userId}
        projectId={projectId} token={token} />
    ) : operation === "trim" ? (
      <VideoTrimEditor initialFile={initialFile} userId={userId}
        projectId={projectId} token={token} />
    ) : operation === "frames" ? (
      <VideoFramesEditor initialFile={initialFile} userId={userId}
        projectId={projectId} token={token} />
    ) : operation === "results" ? (
      <VideoSavedResults userId={userId} projectId={projectId} token={token} />
    ) : (
      legacyEditor
    );
  return (
    <div className="flex flex-col gap-6">
      <VideoOperationTabs value={operation} onChange={setOperation} />
      {screen}
      <AlertDialog open={upscaleConfirmationOpen} onOpenChange={setUpscaleConfirmationOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Increase the video resolution?</AlertDialogTitle>
            <AlertDialogDescription>
              The selected resolution is higher than the original. This does not restore detail and may increase the file size.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => handleProcess(true)}>
              Continue processing
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
