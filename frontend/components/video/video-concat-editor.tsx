"use client";

import { VideoEditorHeader } from "./video-editor-header";

import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useUpdateSession } from "@/lib/mutations/session";
import {
  cancelVideoConcatTask,
  createVideoConcatTask,
  downloadVideoResult,
  getVideoConcatTask,
  listVideoConcatTasks,
  listVideoLibrary,
  listVideoResults,
  ConcatTarget,
  VideoConcatTask,
  VideoLibraryItem,
  VideoResult,
} from "@/lib/video";

// The same video may appear more than once, so each entry needs its own key.
type SequenceItem = { key: number; video: VideoLibraryItem };

const active = (task: VideoConcatTask | null) =>
  task?.status === "queued" || task?.status === "processing";

function message(error: unknown) {
  const e = error as {
    response?: {
      data?: { error?: string; detail?: string; suggestPremium?: boolean };
    };
  };
  const data = e.response?.data;
  if (!data?.error)
    return "Could not contact the service. Please try again.";
  return [
    data.error,
    data.detail,
    data.suggestPremium ? "O perfil Premium permite este pedido." : null,
  ]
    .filter(Boolean)
    .join(" ");
}

function timeText(value: number) {
  const seconds = Math.max(0, Math.round(value));
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function sizeText(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// REQ-VID-CON-007: duração, resolução, FPS, formato, tamanho e áudio.
function metadataText(video: VideoLibraryItem) {
  if (video.duration === undefined) return null;
  return [
    timeText(video.duration),
    `${video.width} × ${video.height}`,
    `${video.fps} fps`,
    `${video.container?.toUpperCase()} (${video.videoCodec?.toUpperCase()})`,
    video.size ? sizeText(video.size) : null,
    video.hasAudio ? `audio ${video.audioCodec?.toUpperCase()}` : "no audio",
  ]
    .filter(Boolean)
    .join(" · ");
}

// Same comparison as the service (RN7): the first differing field against video 1.
function incompatibility(sequence: SequenceItem[]) {
  const reference = sequence[0]?.video.compatibility;
  if (!reference) return null;
  for (let index = 1; index < sequence.length; index++) {
    const fields = sequence[index].video.compatibility;
    if (!fields) continue;
    const position = reference.findIndex(
      (entry, i) =>
        entry.field !== fields[i]?.field || entry.value !== fields[i]?.value,
    );
    if (position >= 0)
      return {
        index,
        label: reference[position].label,
        expected: reference[position].value,
        actual: fields[position]?.value,
      };
  }
  return null;
}

export function VideoConcatEditor({
  userId,
  projectId,
  token,
  onBack,
}: {
  userId?: string;
  projectId?: string;
  token?: string;
  // Optional: the video editor shows its own tabs instead.
  onBack?: () => void;
}) {
  const nextKey = useRef(0);
  const [library, setLibrary] = useState<VideoLibraryItem[]>([]);
  const [sequence, setSequence] = useState<SequenceItem[]>([]);
  const [task, setTask] = useState<VideoConcatTask | null>(null);
  const [results, setResults] = useState<VideoResult[]>([]);
  const [preview, setPreview] = useState<{ id: string; url: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Set when the service asks to confirm re-encoding (CONVERSION_REQUIRED).
  const [conversion, setConversion] = useState<{
    detail?: string;
    target: ConcatTarget;
  } | null>(null);
  const updateSession = useUpdateSession();
  const refreshSession = useRef(updateSession.mutate);
  refreshSession.current = updateSession.mutate;
  const running = active(task);
  const conflict = incompatibility(sequence);
  // Incompatible videos can still be joined after confirming the conversion.
  const valid = sequence.length >= 2;
  const expectedDuration = sequence.reduce(
    (sum, item) => sum + (item.video.duration ?? 0),
    0,
  );
  const concatResults = results.filter((r) => r.inputs !== undefined);

  function entry(video: VideoLibraryItem): SequenceItem {
    nextKey.current += 1;
    return { key: nextKey.current, video };
  }

  useEffect(() => {
    if (!userId || !projectId || !token) {
      setLoading(false);
      return;
    }
    let disposed = false;
    setLoading(true);
    Promise.all([
      listVideoLibrary(userId, projectId, token),
      listVideoConcatTasks(userId, projectId, token),
      listVideoResults(userId, projectId, token),
    ])
      .then(([videos, tasks, saved]) => {
        if (disposed) return;
        setLibrary(videos);
        // Start with this project's video; the order is the selection order (RN2).
        const current = videos.find(
          (v) => v.projectId === projectId && !v.error,
        );
        setSequence(current ? [entry(current)] : []);
        setTask(tasks.find((t) => active(t)) ?? tasks[0] ?? null);
        setResults(saved);
      })
      .catch((e) => {
        if (!disposed) setError(message(e));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [userId, projectId, token]);

  useEffect(() => {
    if (!running || !task || !userId || !projectId || !token) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const id = task.id;
    async function poll() {
      try {
        const current = await getVideoConcatTask(
          userId!,
          projectId!,
          token!,
          id,
        );
        if (disposed) return;
        setError(null);
        if (active(current)) {
          setTask(current);
          timer = setTimeout(poll, 1000);
        } else {
          const saved = await listVideoResults(userId!, projectId!, token!);
          if (disposed) return;
          setResults(saved);
          setTask(current);
          refreshSession.current({ userId: userId!, token: token! });
          if (current.status === "failed")
            setError(current.error || "Joining failed.");
        }
      } catch (e) {
        if (!disposed) {
          setError(message(e));
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

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview.url);
    };
  }, [preview]);

  function change(next: SequenceItem[]) {
    setSequence(next);
    setNotice(null);
    setError(null);
    setConversion(null);
  }
  function move(index: number, offset: number) {
    const next = [...sequence];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    change(next);
  }

  async function submit(convert = false) {
    if (!userId || !projectId || !token || !valid) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setConversion(null);
    try {
      setTask(
        await createVideoConcatTask(
          userId,
          projectId,
          token,
          sequence.map((item) => item.video.projectId),
          convert,
        ),
      );
      refreshSession.current({ userId, token });
    } catch (e) {
      const data = (
        e as {
          response?: {
            data?: { code?: string; detail?: string; target?: ConcatTarget };
          };
        }
      ).response?.data;
      if (data?.code === "CONVERSION_REQUIRED" && data.target) {
        // Nothing was created nor reserved; ask before re-encoding.
        setConversion({ detail: data.detail, target: data.target });
        return;
      }
      setError(message(e));
      // Recover an accepted task if the response was lost. Do not cancel on navigation.
      try {
        const tasks = await listVideoConcatTasks(userId, projectId, token);
        setTask(tasks.find((t) => active(t)) ?? tasks[0] ?? null);
      } catch {
        /* Keep the original error and allow a manual refresh. */
      }
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (!task || !userId || !projectId || !token) return;
    setBusy(true);
    try {
      setTask(await cancelVideoConcatTask(userId, projectId, token, task.id));
      refreshSession.current({ userId, token });
      setNotice("Task canceled.");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  function fetchResult(item: VideoResult) {
    return downloadVideoResult(userId!, projectId!, token!, item.id);
  }
  async function show(item: VideoResult) {
    if (!userId || !projectId || !token) return;
    try {
      const url = URL.createObjectURL(await fetchResult(item));
      setPreview({ id: item.id, url });
    } catch (e) {
      setError(message(e));
    }
  }
  async function download(item: VideoResult) {
    if (!userId || !projectId || !token) return;
    try {
      const object = URL.createObjectURL(await fetchResult(item));
      const link = document.createElement("a");
      link.href = object;
      link.download = item.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(object), 1000);
    } catch (e) {
      setError(message(e));
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <VideoEditorHeader
          title="Join videos"
          description="The originals are preserved. The joined video is saved in the project results. Videos with matching formats, codecs, resolutions and frame rates are joined without quality loss; other videos can be converted to match the first video."
        />
        {onBack && (
          <Button variant="outline" disabled={busy} onClick={onBack}>
            Other operations
          </Button>
        )}
      </div>
      {!userId || !projectId || !token ? (
        <p>
          Open a video project to join videos from your library.
        </p>
      ) : (
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Library</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {loading && (
                  <p className="text-sm text-muted-foreground">
                    Loading videos…
                  </p>
                )}
                {!loading && !library.length && (
                  <p className="text-sm text-muted-foreground">
                    You have not uploaded any videos yet.
                  </p>
                )}
                {library.map((video) => (
                  <div
                    key={video.projectId}
                    className="flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <p className="break-all">{video.name}</p>
                      <p className="text-sm text-muted-foreground">
                        Project: {video.projectName}
                        {video.projectId === projectId && " (this project)"}
                      </p>
                      {video.error ? (
                        <p className="text-sm text-destructive">
                          {video.error}
                        </p>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          {metadataText(video)}
                        </p>
                      )}
                      {video.audioNotice && (
                        <p className="text-sm text-amber-600 dark:text-amber-400">
                          {video.audioNotice}
                        </p>
                      )}
                    </div>
                    <Button
                      variant="outline"
                      className="shrink-0 gap-2"
                      disabled={busy || running || Boolean(video.error)}
                      onClick={() => change([...sequence, entry(video)])}
                    >
                      <Plus className="size-4" />
                      Add
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Sequence</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <fieldset disabled={busy || running} className="space-y-2">
                  {!sequence.length && (
                    <p className="text-sm text-muted-foreground">
                      Add videos from the library in the order you want.
                    </p>
                  )}
                  {sequence.map((item, index) => (
                    <div
                      key={item.key}
                      className={`flex items-center gap-2 rounded border p-2 ${
                        conflict?.index === index ? "border-destructive" : ""
                      }`}
                    >
                      <span className="w-6 text-center text-sm text-muted-foreground">
                        {index + 1}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block break-all">
                          {item.video.name}
                        </span>
                        <span className="block text-sm text-muted-foreground">
                          {metadataText(item.video)}
                        </span>
                      </span>
                      <Button
                        aria-label="Move up"
                        size="icon"
                        variant="ghost"
                        disabled={index === 0}
                        onClick={() => move(index, -1)}
                      >
                        <ArrowUp />
                      </Button>
                      <Button
                        aria-label="Move down"
                        size="icon"
                        variant="ghost"
                        disabled={index === sequence.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        <ArrowDown />
                      </Button>
                      <Button
                        aria-label="Remove from sequence"
                        size="icon"
                        variant="ghost"
                        onClick={() =>
                          change(sequence.filter((s) => s.key !== item.key))
                        }
                      >
                        <X />
                      </Button>
                    </div>
                  ))}
                </fieldset>
                {conflict ? (
                  <p
                    role="status"
                    className="text-sm text-amber-600 dark:text-amber-400"
                  >
                    The videos cannot be joined without conversion. Video{" "}
                    {conflict.index + 1} differs from the first video in: {conflict.label}{" "}
                    ({conflict.actual ?? "—"} instead of {conflict.expected}).
                    You will be asked to confirm the conversion.
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {sequence.length >= 2
                      ? `${sequence.length} videos selected · expected duration ${timeText(expectedDuration)}. The Free plan allows up to 5 videos and Premium up to 20.`
                      : "Select at least two videos to join."}
                  </p>
                )}
                {conversion ? (
                  <div role="alert" className="space-y-2 rounded border p-3">
                    <p>
                      {conversion.detail ??
                        "The videos are not compatible for direct joining."}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      They can be converted to match the first video:{" "}
                      {conversion.target.width} × {conversion.target.height} ·{" "}
                      {conversion.target.fpsValue} fps ·{" "}
                      {conversion.target.container.toUpperCase()} (
                      {conversion.target.videoCodec.toUpperCase()}). Conversion takes longer, re-encodes the video and adds letterboxing when the aspect ratio differs.
                    </p>
                    <Button
                      disabled={busy || running}
                      onClick={() => void submit(true)}
                    >
                      Convert and join
                    </Button>
                    <Button variant="ghost" onClick={() => setConversion(null)}>
                      Back to editing
                    </Button>
                  </div>
                ) : (
                  <Button
                    disabled={!valid || busy || running || loading}
                    onClick={() => void submit()}
                  >
                    {busy ? "Preparing…" : "Join videos"}
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
                    <p className="text-sm text-muted-foreground">
                      {task.inputs.map((i) => i.name).join(" + ")}
                      {task.result &&
                        ` → ${timeText(task.result.duration)} · ${task.result.width} × ${task.result.height} · ${sizeText(task.result.size)}`}
                      {task.mode === "convert" && " · converted"}
                    </p>
                    {task.warnings?.map((warning) => (
                      <p
                        key={warning}
                        className="text-sm text-amber-600 dark:text-amber-400"
                      >
                        {warning}
                      </p>
                    ))}
                    {running && (
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => void cancel()}
                      >
                        Cancel task
                      </Button>
                    )}
                    {running && (
                      <p className="text-sm text-muted-foreground">
                        You can leave this page. The task will continue and will be restored when you return.
                      </p>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Joined videos</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {!concatResults.length && (
                <p className="text-sm text-muted-foreground">
                  No joined videos in this project yet.
                </p>
              )}
              {concatResults.map((item) => (
                <div key={item.id} className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="break-all">{item.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {item.inputs} videos · {timeText(item.duration)}
                        {item.size !== undefined && ` · ${sizeText(item.size)}`}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button variant="outline" onClick={() => void show(item)}>
                        View
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => void download(item)}
                      >
                        Download
                      </Button>
                    </div>
                  </div>
                  {preview?.id === item.id && (
                    <video
                      src={preview.url}
                      controls
                      autoPlay
                      className="max-h-[60vh] w-full rounded bg-black object-contain"
                    />
                  )}
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
