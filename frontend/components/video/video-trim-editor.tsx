"use client";

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
    "Não foi possível contactar o serviço. Tenta novamente."
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
  const [results, setResults] = useState<VideoResult[]>([]);
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
    Promise.all([
      listVideoTrimTasks(userId, projectId, token),
      listVideoResults(userId, projectId, token),
    ])
      .then(([tasks, saved]) => {
        if (disposed) return;
        setHistory(tasks);
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
          const saved = await listVideoResults(userId!, projectId!, token!);
          if (disposed) return;
          setResults(saved);
          setHistory((previous) => [
            current,
            ...previous.filter((t) => t.id !== current.id),
          ]);
          setTask(current);
          refreshSession.current({ userId: userId!, token: token! });
          if (current.status === "failed")
            setError(current.error || "O corte falhou.");
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
        setNotice("Não há nada a recortar. Nenhuma operação foi consumida.");
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
      setNotice("Tarefa cancelada.");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function download(item: VideoResult) {
    if (!userId || !projectId || !token) return;
    try {
      const blob = await downloadVideoResult(userId, projectId, token, item.id);
      const object = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = object;
      link.download = item.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(object), 1000);
    } catch (e) {
      setError(message(e));
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
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">Recortar vídeo</h1>
        {onAudio && (
          <Button variant="outline" disabled={busy} onClick={onAudio}>
            Gerir áudio
          </Button>
        )}
        {onResize && (
          <Button variant="outline" disabled={busy} onClick={onResize}>
            Redimensionar
          </Button>
        )}
      </div>
      {!initialFile || !userId || !projectId || !token ? (
        <p>Abre um projeto de vídeo para recortar o original guardado.</p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            O original é preservado. Os cortes ficam guardados nos resultados do
            projeto.
          </p>
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
                  Pré-visualizar intervalo
                </Button>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Intervalo de corte</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <fieldset disabled={busy || running} className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label htmlFor="trim-start-time">
                        Início (mm:ss.mmm)
                      </Label>
                      <Input
                        id="trim-start-time"
                        value={start}
                        onChange={(e) => change("start", e.target.value)}
                        onBlur={() => settle("start")}
                      />
                    </div>
                    <div>
                      <Label htmlFor="trim-end-time">Fim (mm:ss.mmm)</Label>
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
                      Início na linha temporal
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
                      Fim na linha temporal
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
                        Pontos de corte disponíveis ({points.length})
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
                    <Label htmlFor="trim-mode">Modo</Label>
                    <select
                      id="trim-mode"
                      value={mode}
                      className="w-full rounded border bg-background p-2"
                      onChange={(e) => {
                        setMode(e.target.value as TrimMode);
                        setPlan(null);
                      }}
                    >
                      <option value="fast">Rápido</option>
                      <option value="precise">Preciso</option>
                    </select>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {mode === "precise"
                        ? "Recodifica o intervalo para cortar com precisão ao fotograma."
                        : points
                          ? "Só é possível cortar nos pontos marcados (keyframes). O início e o fim ajustam-se ao ponto mais próximo."
                          : keyframesError
                            ? `Não foi possível obter os pontos de corte (${keyframesError}). Pediremos confirmação se o intervalo mudar.`
                            : "A obter os pontos de corte do vídeo…"}
                    </p>
                  </div>
                </fieldset>
                <p>
                  Duração selecionada:{" "}
                  {valid
                    ? timeText(last - first)
                    : "intervalo inválido (mínimo 1 segundo)"}
                </p>
                <p className="text-sm text-muted-foreground">
                  {estimate === null
                    ? "Tempo de processamento: ainda sem histórico suficiente neste modo."
                    : `Tempo estimado: cerca de ${estimate} s, sem contar o tempo em fila. Pode variar com o vídeo e a carga do sistema.`}
                </p>
                {plan && (
                  <div role="alert" className="space-y-2 rounded border p-3">
                    <p>
                      Intervalo pedido: {timeText(plan.requestedStartSeconds)} —{" "}
                      {timeText(plan.requestedEndSeconds)}
                    </p>
                    <p>
                      Intervalo disponível:{" "}
                      {timeText(plan.effectiveStartSeconds)} —{" "}
                      {timeText(plan.effectiveEndSeconds)}
                    </p>
                    <Button
                      disabled={busy || running}
                      onClick={() => void submit(true)}
                    >
                      Confirmar intervalo disponível
                    </Button>
                    <Button variant="ghost" onClick={() => setPlan(null)}>
                      Voltar a editar
                    </Button>
                  </div>
                )}
                {!plan && (
                  <Button
                    disabled={!valid || busy || running || loading}
                    onClick={() => void submit()}
                  >
                    {busy ? "A preparar…" : "Recortar vídeo"}
                  </Button>
                )}
                {task && (
                  <div className="space-y-2" aria-live="polite">
                    <p>
                      Última tarefa:{" "}
                      {
                        {
                          queued: "Em fila",
                          processing: "A processar",
                          completed: "Concluído",
                          failed: "Falhou",
                          cancelled: "Cancelado",
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
                        Cancelar tarefa
                      </Button>
                    )}
                    {running && (
                      <p className="text-sm text-muted-foreground">
                        Podes sair desta página. A tarefa continua e será
                        recuperada ao regressares.
                      </p>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Resultados guardados</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {!results.length && (
                <p className="text-sm text-muted-foreground">
                  Ainda não existem resultados guardados.
                </p>
              )}
              {results.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-3"
                >
                  <span className="break-all">{item.name}</span>
                  <Button variant="outline" onClick={() => void download(item)}>
                    Descarregar
                  </Button>
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
