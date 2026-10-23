"use client";

import { VideoEditorHeader } from "./video-editor-header";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { useUpdateSession } from "@/lib/mutations/session";
import {
  cancelVideoTrimTask,
  createVideoTrimTask,
  downloadVideoResult,
  getVideoTrimKeyframes,
  getVideoTrimTask,
  listVideoResults,
  listVideoTrimTasks,
  TrimMode,
  TrimPlan,
  VideoResult,
  VideoTrimTask,
} from "@/lib/video";

function timeText(value: number) {
  const milliseconds = Math.max(0, Math.round(value * 1000));
  return `${Math.floor(milliseconds / 60000)
    .toString()
    .padStart(
      2,
      "0",
    )}:${((milliseconds % 60000) / 1000).toFixed(3).padStart(6, "0")}`;
}

function parseTime(value: string) {
  if (!/^\d+:\d{2}(?:\.\d{1,3})?$/.test(value)) return NaN;
  const [minutes, seconds] = value.split(":").map(Number);
  return seconds < 60 ? minutes * 60 + seconds : NaN;
}
// Nearest fast-mode cut point. A cut cannot start at the end or end at 0.
function snap(value: number, points: number[], which: "start" | "end") {
  const options = which === "start" ? points.slice(0, -1) : points.slice(1);
  return options.reduce(
    (best, point) =>
      Math.abs(point - value) < Math.abs(best - value) ? point : best,
    options[0] ?? value,
  );
}
const active = (task: VideoTrimTask | null) =>
  task?.status === "queued" || task?.status === "processing";
function message(error: unknown) {
  const e = error as { response?: { data?: { error?: string } } };
  return (
    e.response?.data?.error ||
    "Could not contact the service. Please try again."
  );
}

export function VideoTrimEditor({
  initialFile,
  userId,
  projectId,
  token,
  onResize,
  onAudio,
}: {
  initialFile?: File;
  userId?: string;
  projectId?: string;
  token?: string;
  // Optional: the video editor shows its own tabs instead.
  onResize?: () => void;
  onAudio?: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [url, setUrl] = useState<string>();
  const [duration, setDuration] = useState(0);
  const [start, setStart] = useState("00:00.000");
  const [end, setEnd] = useState("00:00.000");
  const [mode, setMode] = useState<TrimMode>("fast");
  const [plan, setPlan] = useState<TrimPlan | null>(null);
  const [task, setTask] = useState<VideoTrimTask | null>(null);
  const [history, setHistory] = useState<VideoTrimTask[]>([]);
  const [latestResult, setLatestResult] = useState<VideoResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [keyframes, setKeyframes] = useState<number[] | null>(null);
  const [cutDuration, setCutDuration] = useState(0);
  const [keyframesError, setKeyframesError] = useState<string | null>(null);
  const updateSession = useUpdateSession();
  const refreshSession = useRef(updateSession.mutate);
  refreshSession.current = updateSession.mutate;
  const running = active(task);
  // In fast mode the cut can only use keyframes, so the controls snap to them.
  const points = mode === "fast" && keyframes?.length ? keyframes : null;
  const typedFirst = parseTime(start),
    typedLast = parseTime(end);
  // Send the exact keyframe time; the text box rounds it to milliseconds.
  const first =
    points && Number.isFinite(typedFirst)
      ? snap(typedFirst, points, "start")
      : typedFirst;
  const last =
    points && Number.isFinite(typedLast)
      ? snap(typedLast, points, "end")
      : typedLast;
  const limit = Math.max(duration, cutDuration);
  const valid =
    Number.isFinite(first) &&
    Number.isFinite(last) &&
    first >= 0 &&
    last <= limit + 0.001 &&
    last - first >= 1;

  const samples = history
    .filter(
      (t) =>
        t.mode === mode &&
        t.status === "completed" &&
        t.startedAt &&
        t.finishedAt,
    )
    .slice(0, 10)
    .map((t) => ({
      elapsed: (Date.parse(t.finishedAt!) - Date.parse(t.startedAt!)) / 1000,
      duration: t.effectiveEndSeconds - t.effectiveStartSeconds,
    }))
    .filter((t) => t.elapsed > 0 && t.duration > 0);
  const estimate =
    valid && samples.length
      ? Math.max(
          1,
          Math.ceil(
            ((last - first) * samples.reduce((sum, t) => sum + t.elapsed, 0)) /
              samples.reduce((sum, t) => sum + t.duration, 0),
          ),
        )
      : null;

  useEffect(() => {
    if (!initialFile) return;
    const next = URL.createObjectURL(initialFile);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [initialFile]);

  useEffect(() => {
    if (!userId || !projectId || !token) {
      setLoading(false);
      return;
    }
    let disposed = false;
    setLoading(true);
    listVideoTrimTasks(userId, projectId, token)
      .then((tasks) => {
        if (disposed) return;
        setHistory(tasks);
        setTask(tasks.find((t) => active(t)) ?? tasks[0] ?? null);
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
    if (!userId || !projectId || !token) return;
    let disposed = false;
    getVideoTrimKeyframes(userId, projectId, token)
      .then((result) => {
        if (disposed) return;
        setKeyframes(result.keyframes);
        setCutDuration(result.durationSeconds);
      })
      .catch((e) => {
        if (!disposed) setKeyframesError(message(e));
      });
    return () => {
      disposed = true;
    };
  }, [userId, projectId, token]);

  // Entering fast mode (or receiving the points) moves both ends to a keyframe.
  useEffect(() => {
    if (mode !== "fast" || !keyframes?.length) return;
    setStart((value) => {
      const time = parseTime(value);
      return Number.isFinite(time)
        ? timeText(snap(time, keyframes, "start"))
        : value;
    });
    setEnd((value) => {
      const time = parseTime(value);
      return Number.isFinite(time)
        ? timeText(snap(time, keyframes, "end"))
        : value;
    });
  }, [mode, keyframes]);

  useEffect(() => {
    if (!running || !task || !userId || !projectId || !token) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const id = task.id;
    async function poll() {
      try {
        const current = await getVideoTrimTask(userId!, projectId!, token!, id);
        if (disposed) return;
        setError(null);
        if (active(current)) {
          setTask(current);
          timer = setTimeout(poll, 1000);
        } else {
          if (current.status === "completed") {
            const saved = await listVideoResults(userId!, projectId!, token!);
            const result = saved.find((item) => item.id === current.id);
            if (result) setLatestResult(result);
          }
          setHistory((previous) => [
            current,
            ...previous.filter((t) => t.id !== current.id),
          ]);
          setTask(current);
          refreshSession.current({ userId: userId!, token: token! });
          if (current.status === "failed")
            setError(current.error || "Trimming failed.");
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

  async function submit(confirmed = false) {
    if (!userId || !projectId || !token || !valid) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await createVideoTrimTask(
        userId,
        projectId,
        token,
        confirmed && plan ? plan.effectiveStartSeconds : first,
        confirmed && plan ? plan.effectiveEndSeconds : last,
        mode,
      );
      if ("id" in result) {
        setTask(result);
        setPlan(null);
        refreshSession.current({ userId, token });
      } else if (result.status === "confirmation_required") setPlan(result);
      else {
        setPlan(null);
        setNotice("There is nothing to trim. No operation was used.");
      }
    } catch (e) {
      setError(message(e));
      // Recover an accepted task if the response was lost. Do not cancel on navigation.
      try {
        const tasks = await listVideoTrimTasks(userId, projectId, token);
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
      setTask(await cancelVideoTrimTask(userId, projectId, token, task.id));
      refreshSession.current({ userId, token });
      setNotice("Task canceled.");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  // Typed times snap to the nearest keyframe once the field loses focus.
  function settle(which: "start" | "end") {
    if (!points) return;
    const time = parseTime(which === "start" ? start : end);
    if (Number.isFinite(time))
      change(which, timeText(snap(time, points, which)));
  }
  function change(which: "start" | "end", value: string) {
    setPlan(null);
    setNotice(null);
    setPreviewing(false);
    video.current?.pause();
    if (which === "start") setStart(value);
    else setEnd(value);
  }
  async function downloadLatestResult() {
    if (!latestResult || !userId || !projectId || !token) return;
    try {
      const blob = await downloadVideoResult(
        userId,
        projectId,
        token,
        latestResult.id,
      );
      const object = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = object;
      link.download = latestResult.name;
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
          title="Trim video"
          description="The original is preserved. Trimmed videos are saved in the project results."
        />
        {onAudio && (
          <Button variant="outline" disabled={busy} onClick={onAudio}>
            Manage audio
          </Button>
        )}
        {onResize && (
          <Button variant="outline" disabled={busy} onClick={onResize}>
            Resize
          </Button>
        )}
      </div>
      {!initialFile || !userId || !projectId || !token ? (
        <p>Open a video project to trim the saved original.</p>
      ) : (
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>{initialFile.name}</CardTitle>
              </CardHeader>
              <CardContent>
                <video
                  ref={video}
                  src={url}
                  controls
                  className="max-h-[60vh] w-full rounded bg-black object-contain"
                  onLoadedMetadata={(e) => {
                    const d = e.currentTarget.duration;
                    setDuration(d);
                    setEnd(timeText(d));
                  }}
                  onTimeUpdate={(e) => {
                    if (previewing && e.currentTarget.currentTime >= last) {
                      e.currentTarget.pause();
                      setPreviewing(false);
                    }
                  }}
                />
                <Button
                  className="mt-4"
                  variant="outline"
                  disabled={!valid}
                  onClick={() => {
                    if (!video.current) return;
                    video.current.currentTime = first;
                    setPreviewing(true);
                    void video.current.play().catch(() => setPreviewing(false));
                  }}
                >
                  Preview range
                </Button>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Trim range</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <fieldset disabled={busy || running} className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label htmlFor="trim-start-time">
                        Start (mm:ss.mmm)
                      </Label>
                      <Input
                        id="trim-start-time"
                        value={start}
                        onChange={(e) => change("start", e.target.value)}
                        onBlur={() => settle("start")}
                      />
                    </div>
                    <div>
                      <Label htmlFor="trim-end-time">End (mm:ss.mmm)</Label>
                      <Input
                        id="trim-end-time"
                        value={end}
                        onChange={(e) => change("end", e.target.value)}
                        onBlur={() => settle("end")}
                      />
                    </div>
                  </div>
                  <div>
                    <Label htmlFor="trim-start-slider">
                      Timeline start
                    </Label>
                    <input
                      id="trim-start-slider"
                      type="range"
                      min={0}
                      max={limit}
                      step={0.001}
                      value={Number.isFinite(first) ? first : 0}
                      className="w-full"
                      onChange={(e) => {
                        const time = Number(e.target.value);
                        change(
                          "start",
                          timeText(points ? snap(time, points, "start") : time),
                        );
                      }}
                    />
                  </div>
                  <div>
                    <Label htmlFor="trim-end-slider">
                      Timeline end
                    </Label>
                    <input
                      id="trim-end-slider"
                      type="range"
                      min={0}
                      max={limit}
                      step={0.001}
                      value={Number.isFinite(last) ? last : 0}
                      className="w-full"
                      onChange={(e) => {
                        const time = Number(e.target.value);
                        change(
                          "end",
                          timeText(points ? snap(time, points, "end") : time),
                        );
                      }}
                    />
                  </div>
                  {points && limit > 0 && (
                    <div>
                      <p className="text-sm text-muted-foreground">
                        Available keyframes ({points.length})
                      </p>
                      <div
                        aria-hidden
                        className="relative mt-1 h-4 w-full rounded bg-muted"
                      >
                        {points.map((point) => (
                          <span
                            key={point}
                            title={timeText(point)}
                            className="absolute top-0 h-4 w-0.5 -translate-x-1/2 bg-primary"
                            style={{ left: `${(point / limit) * 100}%` }}
                          />
                        ))}
                        {valid && (
                          <span
                            className="absolute top-0 h-4 rounded bg-primary/30"
                            style={{
                              left: `${(first / limit) * 100}%`,
                              width: `${((last - first) / limit) * 100}%`,
                            }}
                          />
                        )}
                      </div>
                    </div>
                  )}
                  <div>
                    <Label htmlFor="trim-mode">Mode</Label>
                    <select
                      id="trim-mode"
                      value={mode}
                      className="w-full rounded border bg-background p-2"
                      onChange={(e) => {
                        setMode(e.target.value as TrimMode);
                        setPlan(null);
                      }}
                    >
                      <option value="fast">Fast</option>
                      <option value="precise">Precise</option>
                    </select>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {mode === "precise"
                        ? "Re-encodes the selected range for frame-accurate trimming."
                        : points
                          ? "Trimming is only possible at the marked keyframes. The start and end snap to the nearest point."
                          : keyframesError
                            ? `Could not load keyframes (${keyframesError}). You will be asked to confirm if the range changes.`
                            : "Loading video keyframes…"}
                    </p>
                  </div>
                </fieldset>
                <p>
                  Selected duration:{" "}
                  {valid
                    ? timeText(last - first)
                    : "invalid range (minimum 1 second)"}
                </p>
                <p className="text-sm text-muted-foreground">
                  {estimate === null
                    ? "Processing time: not enough history for this mode yet."
                    : `Estimated time: about ${estimate} s, excluding queue time. This may vary with the video and system load.`}
                </p>
                {plan && (
                  <div role="alert" className="space-y-2 rounded border p-3">
                    <p>
                      Intervalo pedido: {timeText(plan.requestedStartSeconds)} —{" "}
                      {timeText(plan.requestedEndSeconds)}
                    </p>
                    <p>
                      Available range:{" "}
                      {timeText(plan.effectiveStartSeconds)} —{" "}
                      {timeText(plan.effectiveEndSeconds)}
                    </p>
                    <Button
                      disabled={busy || running}
                      onClick={() => void submit(true)}
                    >
                      Confirm available range
                    </Button>
                    <Button variant="ghost" onClick={() => setPlan(null)}>
                      Back to editing
                    </Button>
                  </div>
                )}
                {!plan && (
                  <Button
                    disabled={!valid || busy || running || loading}
                    onClick={() => void submit()}
                  >
                    {busy ? "Preparing…" : "Trim video"}
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
          {latestResult && (
            <Card>
              <CardHeader>
                <CardTitle>Trimmed video ready</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center justify-between gap-3">
                <span className="break-all">{latestResult.name}</span>
                <Button variant="outline" onClick={() => void downloadLatestResult()}>
                  Download
                </Button>
              </CardContent>
            </Card>
          )}
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
