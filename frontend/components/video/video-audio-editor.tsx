"use client";

import { VideoEditorHeader } from "./video-editor-header";

import { NumberInput } from "@/components/ui/number-input";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { useUpdateSession } from "@/lib/mutations/session";
import {
  AudioMetadata,
  AudioParameters,
  AudioPlan,
  AudioTask,
  VideoResult,
  cancelVideoAudioTask,
  createVideoAudioTask,
  downloadVideoResult,
  getVideoAudioTask,
  inspectVideoAudio,
  listVideoAudioTasks,
  listVideoResults,
} from "@/lib/video";

const active = (task: AudioTask | null) =>
  task?.status === "queued" || task?.status === "processing";
function errorMessage(error: unknown) {
  return (
    (error as { response?: { data?: { error?: string } } }).response?.data
      ?.error || "Could not contact the audio service."
  );
}

export function VideoAudioEditor({
  initialFile,
  userId,
  projectId,
  token,
  onTrim,
  onResize,
}: {
  initialFile?: File;
  userId?: string;
  projectId?: string;
  token?: string;
  // Optional: the video editor shows its own tabs instead.
  onTrim?: () => void;
  onResize?: () => void;
}) {
  const [sourceResultId, setSourceResultId] = useState("");
  const [sourceUrl, setSourceUrl] = useState<string>();
  const [metadata, setMetadata] = useState<AudioMetadata | null>(null);
  const [file, setFile] = useState<File>();
  const [audioDuration, setAudioDuration] = useState<number | null>(null);
  const [params, setParams] = useState<AudioParameters>({
    operation: "volume",
    volume: 100,
    originalVolume: 100,
    overlayMode: "replace",
    startSeconds: 0,
    fadeIn: 0,
    fadeOut: 0,
    shortPolicy: "",
  });
  const [task, setTask] = useState<AudioTask | null>(null);
  const [plan, setPlan] = useState<AudioPlan | null>(null);
  const [results, setResults] = useState<VideoResult[]>([]);
  const [preview, setPreview] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const updateSession = useUpdateSession();
  const refreshSession = useRef(updateSession.mutate);
  refreshSession.current = updateSession.mutate;
  const running = active(task);
  const duration = metadata?.video.duration || 0;
  const short =
    audioDuration !== null &&
    audioDuration < duration - params.startSeconds - 0.000001;

  useEffect(() => {
    let disposed = false;
    let object: string | undefined;
    if (sourceResultId && userId && projectId && token) {
      downloadVideoResult(userId, projectId, token, sourceResultId)
        .then((blob) => {
          if (!disposed) {
            object = URL.createObjectURL(blob);
            setSourceUrl(object);
          }
        })
        .catch((e) => {
          if (!disposed) setError(errorMessage(e));
        });
    } else if (initialFile) {
      object = URL.createObjectURL(initialFile);
      setSourceUrl(object);
    }
    return () => {
      disposed = true;
      if (object) URL.revokeObjectURL(object);
    };
  }, [initialFile, sourceResultId, userId, projectId, token]);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );

  useEffect(() => {
    if (!userId || !projectId || !token) {
      setLoading(false);
      return;
    }
    let disposed = false;
    setLoading(true);
    Promise.all([
      inspectVideoAudio(
        userId,
        projectId,
        token,
        undefined,
        sourceResultId || undefined,
      ),
      listVideoAudioTasks(userId, projectId, token),
      listVideoResults(userId, projectId, token),
    ])
      .then(([info, tasks, saved]) => {
        if (disposed) return;
        setMetadata(info);
        setResults(saved);
        setTask(tasks.find((t) => active(t)) ?? tasks[0] ?? null);
        if (!info.video.has_audio)
          setParams((p) => ({
            ...p,
            operation: "overlay",
            overlayMode: "replace",
          }));
        setError(null);
      })
      .catch((e) => {
        if (!disposed) setError(errorMessage(e));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [userId, projectId, token, reload, sourceResultId]);

  useEffect(() => {
    setAudioDuration(null);
    if (!file || !userId || !projectId || !token) {
      setInspecting(false);
      return;
    }
    let disposed = false;
    setInspecting(true);
    inspectVideoAudio(
      userId,
      projectId,
      token,
      file,
      sourceResultId || undefined,
    )
      .then((info) => {
        if (!disposed) {
          setAudioDuration(info.audio?.duration ?? null);
          setError(null);
        }
      })
      .catch((e) => {
        if (!disposed) setError(errorMessage(e));
      })
      .finally(() => {
        if (!disposed) setInspecting(false);
      });
    return () => {
      disposed = true;
    };
  }, [file, userId, projectId, token, sourceResultId]);

  useEffect(() => {
    if (!running || !task || !userId || !projectId || !token) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const id = task.id;
    async function poll() {
      try {
        const current = await getVideoAudioTask(
          userId!,
          projectId!,
          token!,
          id,
        );
        if (disposed) return;
        if (active(current)) {
          setTask(current);
          timer = setTimeout(poll, 1000);
        } else {
          const saved = await listVideoResults(userId!, projectId!, token!);
          if (disposed) return;
          setTask(current);
          setResults(saved);
          refreshSession.current({ userId: userId!, token: token! });
          setError(
            current.status === "failed"
              ? (typeof current.error === "string"
                  ? current.error
                  : current.error?.message) || "Audio processing failed."
              : null,
          );
          if (current.status === "completed")
            setNotice(
              "New video saved in the project. The additional audio file has been removed from the server.",
            );
        }
      } catch (e) {
        if (!disposed) {
          setError(errorMessage(e));
          timer = setTimeout(poll, 3000);
        }
      }
    }
    timer = setTimeout(poll, 500);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [running, task?.id, userId, projectId, token]);

  function edit(update: Partial<AudioParameters>) {
    setParams((p) => ({ ...p, ...update }));
    setPlan(null);
    setNotice(null);
  }
  async function submit(confirmed = false) {
    if (!userId || !projectId || !token) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await createVideoAudioTask(
        userId,
        projectId,
        token,
        params,
        file,
        confirmed,
        sourceResultId || undefined,
      );
      if ("id" in response) {
        setTask(response);
        setPlan(null);
        refreshSession.current({ userId, token });
      } else {
        setPlan(response);
        if (response.message) setNotice(response.message);
      }
    } catch (e) {
      setError(errorMessage(e));
      try {
        const tasks = await listVideoAudioTasks(userId, projectId, token);
        setTask(tasks.find((t) => active(t)) ?? tasks[0] ?? null);
      } catch {
        /* Original error retained. */
      }
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (!userId || !projectId || !token || !task) return;
    setBusy(true);
    try {
      setTask(await cancelVideoAudioTask(userId, projectId, token, task.id));
      refreshSession.current({ userId, token });
      setNotice("Task canceled.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function openResult(result: VideoResult, download: boolean) {
    if (!userId || !projectId || !token) return;
    try {
      const blob = await downloadVideoResult(
        userId,
        projectId,
        token,
        result.id,
      );
      const object = URL.createObjectURL(blob);
      if (download) {
        const a = document.createElement("a");
        a.href = object;
        a.download = result.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(object), 1000);
      } else setPreview(object);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  const disabled = busy || running || inspecting || loading;
  const overlayReady =
    params.operation !== "overlay" ||
    (file && audioDuration !== null && (!short || params.shortPolicy));

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <VideoEditorHeader
          title="Manage video audio"
          description="The video stream is copied without re-encoding. The original is preserved and the result is saved in the project."
        />
        <div className="flex gap-2">
          {onTrim && (
            <Button variant="outline" onClick={onTrim}>
              Trim
            </Button>
          )}
          {onResize && (
            <Button variant="outline" onClick={onResize}>
              Resize
            </Button>
          )}
        </div>
      </div>
      {!initialFile || !userId || !projectId || !token ? (
        <p>Open a video project to edit the audio of the saved original.</p>
      ) : (
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Input video</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <Label htmlFor="audio-source">
                    Choose a video from the library
                  </Label>
                  <select
                    id="audio-source"
                    value={sourceResultId}
                    disabled={busy || loading || running}
                    className="w-full rounded border bg-background p-2"
                    onChange={(e) => {
                      setSourceResultId(e.target.value);
                      setMetadata(null);
                      setPlan(null);
                      setNotice(null);
                    }}
                  >
                    <option value="">Project original</option>
                    {results.map((result) => (
                      <option key={result.id} value={result.id}>
                        {result.name}
                      </option>
                    ))}
                  </select>
                </div>
                <video
                  src={sourceUrl}
                  controls
                  className="max-h-96 w-full rounded bg-black"
                />
                {metadata && (
                  <p>
                    {duration.toFixed(3)} s · {metadata.video.width} ×{" "}
                    {metadata.video.height} ·{" "}
                    {metadata.video.has_audio
                      ? "With audio"
                      : "No audio track"}
                  </p>
                )}
                {metadata?.video.audioNotice && (
                  <p className="text-sm text-amber-600 dark:text-amber-400">
                    {metadata.video.audioNotice}
                  </p>
                )}
                {!metadata && !loading && (
                  <Button
                    variant="outline"
                    onClick={() => setReload((r) => r + 1)}
                  >
                    Reload metadata
                  </Button>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Audio operation</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <fieldset
                  disabled={disabled || !metadata}
                  className="space-y-4"
                >
                  <div>
                    <Label htmlFor="audio-operation">Operation</Label>
                    <select
                      id="audio-operation"
                      value={params.operation}
                      className="w-full rounded border bg-background p-2"
                      onChange={(e) =>
                        edit({
                          operation: e.target
                            .value as AudioParameters["operation"],
                        })
                      }
                    >
                      {metadata?.video.has_audio && (
                        <>
                          <option value="volume">Adjust volume</option>
                          <option value="remove">Remove audio</option>
                        </>
                      )}
                      <option value="overlay">Overlay audio</option>
                    </select>
                  </div>
                  {params.operation === "overlay" && (
                    <>
                      <div>
                        <Label htmlFor="auxiliary-audio">
                          New audio (MP3, WAV, AAC or OGG; maximum 20 MB)
                        </Label>
                        <Input
                          id="auxiliary-audio"
                          type="file"
                          accept=".mp3,.wav,.aac,.ogg,audio/mpeg,audio/wav,audio/aac,audio/ogg"
                          onChange={(e) => {
                            const selected = e.target.files?.[0];
                            setPlan(null);
                            setAudioDuration(null);
                            if (selected && selected.size > 20_000_000) {
                              setFile(undefined);
                              setError("The audio file exceeds 20 MB.");
                              return;
                            }
                            setFile(selected);
                            edit({ shortPolicy: "" });
                          }}
                        />
                        {file && (
                          <p className="mt-1 text-sm">
                            {file.name} ·{" "}
                            {inspecting
                              ? "Validating…"
                              : audioDuration === null
                                ? "Duration unavailable"
                                : `${audioDuration.toFixed(3)} s`}
                          </p>
                        )}
                      </div>
                      <div>
                        <Label htmlFor="audio-overlay-mode">
                          Overlay mode
                        </Label>
                        <select
                          id="audio-overlay-mode"
                          value={params.overlayMode}
                          onChange={(e) =>
                            edit({
                              overlayMode: e.target.value as "mix" | "replace",
                            })
                          }
                          className="w-full rounded border bg-background p-2"
                        >
                          <option value="replace">
                            Replace the original audio
                          </option>
                          {metadata?.video.has_audio && (
                            <option value="mix">
                              Mix with the original audio
                            </option>
                          )}
                        </select>
                      </div>
                      <div>
                        <Label htmlFor="audio-start">
                          New audio start time in the video (seconds)
                        </Label>
                        <NumberInput
                          id="audio-start"
                          label="New audio start time"
                          min={0}
                          max={duration}
                          step={0.001}
                          value={params.startSeconds}
                          onValueChange={(value) =>
                            edit({ startSeconds: value })
                          }
                        />
                      </div>
                      {params.overlayMode === "mix" && (
                        <div>
                          <Label htmlFor="original-volume">
                            Original audio volume (%)
                          </Label>
                          <NumberInput
                            id="original-volume"
                            label="Original audio volume"
                            min={0}
                            max={300}
                            value={params.originalVolume}
                            onValueChange={(value) =>
                              edit({ originalVolume: value })
                            }
                          />
                          <p className="text-sm text-muted-foreground">
                            Mixing does not automatically normalize the volume and may cause clipping.
                          </p>
                        </div>
                      )}
                      {short && (
                        <div>
                          <Label htmlFor="audio-short-policy">
                            The new audio ends before the video
                          </Label>
                          <select
                            id="audio-short-policy"
                            value={params.shortPolicy}
                            onChange={(e) =>
                              edit({
                                shortPolicy: e.target
                                  .value as AudioParameters["shortPolicy"],
                              })
                            }
                            className="w-full rounded border bg-background p-2"
                          >
                            <option value="">Choose what happens</option>
                            <option value="repeat">
                              Repeat until the end of the video
                            </option>
                            <option value="silence">
                              {params.overlayMode === "mix"
                                ? "Let it end and keep only the original audio"
                                : "Let it end and leave silence"}
                            </option>
                          </select>
                        </div>
                      )}
                    </>
                  )}
                  {params.operation !== "remove" && (
                    <>
                      <div>
                        <Label htmlFor="audio-volume">
                          {params.operation === "overlay"
                            ? "New audio volume (%)"
                            : "Volume (%)"}
                        </Label>
                        <NumberInput
                          id="audio-volume"
                          label="volume"
                          min={0}
                          max={300}
                          value={params.volume}
                          onValueChange={(value) =>
                            edit({ volume: value })
                          }
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <Label htmlFor="audio-fade-in">Fade in (0–5 s)</Label>
                          <NumberInput
                            id="audio-fade-in"
                            label="fade in"
                            min={0}
                            max={5}
                            step={0.1}
                            value={params.fadeIn}
                            onValueChange={(value) =>
                              edit({ fadeIn: value })
                            }
                          />
                        </div>
                        <div>
                          <Label htmlFor="audio-fade-out">
                            Fade out (0–5 s)
                          </Label>
                          <NumberInput
                            id="audio-fade-out"
                            label="fade out"
                            min={0}
                            max={5}
                            step={0.1}
                            value={params.fadeOut}
                            onValueChange={(value) =>
                              edit({ fadeOut: value })
                            }
                          />
                        </div>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        Fades are applied once to the effective audio, after looping or trimming. Their combined length cannot exceed its duration.
                      </p>
                    </>
                  )}
                </fieldset>
                {params.operation === "volume" && params.volume === 0 && (
                  <Button
                    variant="outline"
                    disabled={disabled}
                    onClick={() => edit({ operation: "remove" })}
                  >
                    Remove the track instead of muting it
                  </Button>
                )}
                {plan?.status === "confirmation_required" ? (
                  <div role="alert" className="space-y-3 rounded border p-3">
                    {plan.warnings?.map((w) => (
                      <p key={w.code}>{w.message}</p>
                    ))}
                    <Button
                      disabled={disabled}
                      onClick={() => void submit(true)}
                    >
                      Confirm and process
                    </Button>
                    <Button variant="ghost" onClick={() => setPlan(null)}>
                      Back to settings
                    </Button>
                  </div>
                ) : (
                  <Button
                    disabled={disabled || !metadata || !overlayReady}
                    onClick={() => void submit()}
                  >
                    {busy ? "Preparing…" : "Process audio"}
                  </Button>
                )}
                {task && (
                  <div className="space-y-2" aria-live="polite">
                    <p>
                      Latest task:{" "}
                      {
                        {
                          queued: "Queued",
                          processing: "Processing",
                          completed: "Completed",
                          failed: "Failed",
                          cancelled: "Canceled",
                        }[task.status]
                      }{" "}
                      · {task.progress}%
                    </p>
                    <Progress value={task.progress} />
                    {running && (
                      <>
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() => void cancel()}
                        >
                          Cancel task
                        </Button>
                        <p className="text-sm text-muted-foreground">
                          You can leave and return later. The task will continue on the server.
                        </p>
                      </>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Saved results</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {preview && (
                <video
                  src={preview}
                  controls
                  className="max-h-96 w-full rounded bg-black"
                />
              )}
              {!results.length && <p>No results yet.</p>}
              {results.map((result) => (
                <div
                  key={result.id}
                  className="flex flex-wrap items-center justify-between gap-2"
                >
                  <span className="break-all">{result.name}</span>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      onClick={() => void openResult(result, false)}
                    >
                      Preview
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => void openResult(result, true)}
                    >
                      Download
                    </Button>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
