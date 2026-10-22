"use client";

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
      ?.error || "Não foi possível contactar o serviço de áudio."
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
  onTrim: () => void;
  onResize: () => void;
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
              ? current.error || "A operação de áudio falhou."
              : null,
          );
          if (current.status === "completed")
            setNotice(
              "Novo vídeo guardado no projeto. O áudio auxiliar foi eliminado do servidor.",
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
      setNotice("Tarefa cancelada.");
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
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Gerir áudio do vídeo</h1>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onTrim}>
            Recortar
          </Button>
          <Button variant="outline" onClick={onResize}>
            Redimensionar
          </Button>
        </div>
      </div>
      {!initialFile || !userId || !projectId || !token ? (
        <p>Abre um projeto de vídeo para gerir o áudio do original guardado.</p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            A imagem é copiada sem recodificação. O original mantém-se
            inalterado e o resultado fica guardado no projeto.
          </p>
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Vídeo de entrada</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <Label htmlFor="audio-source">
                    Escolher vídeo da biblioteca
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
                    <option value="">Original do projeto</option>
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
                      ? "Com áudio"
                      : "Sem faixa de áudio"}
                  </p>
                )}
                {!metadata && !loading && (
                  <Button
                    variant="outline"
                    onClick={() => setReload((r) => r + 1)}
                  >
                    Repetir leitura dos metadados
                  </Button>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Operação de áudio</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <fieldset
                  disabled={disabled || !metadata}
                  className="space-y-4"
                >
                  <div>
                    <Label htmlFor="audio-operation">Operação</Label>
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
                          <option value="volume">Ajustar volume</option>
                          <option value="remove">Remover áudio</option>
                        </>
                      )}
                      <option value="overlay">Sobrepor áudio</option>
                    </select>
                  </div>
                  {params.operation === "overlay" && (
                    <>
                      <div>
                        <Label htmlFor="auxiliary-audio">
                          Novo áudio (MP3, WAV, AAC ou OGG; máximo 20 MB)
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
                              setError("O áudio excede 20 MB.");
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
                              ? "A validar…"
                              : audioDuration === null
                                ? "Duração indisponível"
                                : `${audioDuration.toFixed(3)} s`}
                          </p>
                        )}
                      </div>
                      <div>
                        <Label htmlFor="audio-overlay-mode">
                          Modo de sobreposição
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
                            Substituir o áudio original
                          </option>
                          {metadata?.video.has_audio && (
                            <option value="mix">
                              Misturar com o áudio original
                            </option>
                          )}
                        </select>
                      </div>
                      <div>
                        <Label htmlFor="audio-start">
                          Início do novo áudio no vídeo (segundos)
                        </Label>
                        <Input
                          id="audio-start"
                          type="number"
                          min={0}
                          max={duration}
                          step={0.001}
                          value={params.startSeconds}
                          onChange={(e) =>
                            edit({ startSeconds: Number(e.target.value) })
                          }
                        />
                      </div>
                      {params.overlayMode === "mix" && (
                        <div>
                          <Label htmlFor="original-volume">
                            Volume do áudio original (%)
                          </Label>
                          <Input
                            id="original-volume"
                            type="number"
                            min={0}
                            max={300}
                            value={params.originalVolume}
                            onChange={(e) =>
                              edit({ originalVolume: Number(e.target.value) })
                            }
                          />
                          <p className="text-sm text-muted-foreground">
                            A mistura não normaliza automaticamente o volume e
                            pode saturar.
                          </p>
                        </div>
                      )}
                      {short && (
                        <div>
                          <Label htmlFor="audio-short-policy">
                            O novo áudio termina antes do vídeo
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
                            <option value="">Escolhe o comportamento</option>
                            <option value="repeat">
                              Repetir até ao fim do vídeo
                            </option>
                            <option value="silence">
                              {params.overlayMode === "mix"
                                ? "Deixar terminar e manter só o original"
                                : "Deixar terminar e ficar em silêncio"}
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
                            ? "Volume do novo áudio (%)"
                            : "Volume (%)"}
                        </Label>
                        <Input
                          id="audio-volume"
                          type="number"
                          min={0}
                          max={300}
                          value={params.volume}
                          onChange={(e) =>
                            edit({ volume: Number(e.target.value) })
                          }
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <Label htmlFor="audio-fade-in">Fade in (0–5 s)</Label>
                          <Input
                            id="audio-fade-in"
                            type="number"
                            min={0}
                            max={5}
                            step={0.1}
                            value={params.fadeIn}
                            onChange={(e) =>
                              edit({ fadeIn: Number(e.target.value) })
                            }
                          />
                        </div>
                        <div>
                          <Label htmlFor="audio-fade-out">
                            Fade out (0–5 s)
                          </Label>
                          <Input
                            id="audio-fade-out"
                            type="number"
                            min={0}
                            max={5}
                            step={0.1}
                            value={params.fadeOut}
                            onChange={(e) =>
                              edit({ fadeOut: Number(e.target.value) })
                            }
                          />
                        </div>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        Os fades aplicam-se uma vez ao áudio efetivo, depois da
                        repetição ou corte. A soma não pode exceder a sua
                        duração.
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
                    Remover a faixa em vez de silenciar
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
                      Confirmar e processar
                    </Button>
                    <Button variant="ghost" onClick={() => setPlan(null)}>
                      Voltar à configuração
                    </Button>
                  </div>
                ) : (
                  <Button
                    disabled={disabled || !metadata || !overlayReady}
                    onClick={() => void submit()}
                  >
                    {busy ? "A preparar…" : "Processar áudio"}
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
                      <>
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() => void cancel()}
                        >
                          Cancelar tarefa
                        </Button>
                        <p className="text-sm text-muted-foreground">
                          Podes sair e voltar mais tarde. A tarefa continua no
                          servidor.
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
              <CardTitle>Resultados guardados</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {preview && (
                <video
                  src={preview}
                  controls
                  className="max-h-96 w-full rounded bg-black"
                />
              )}
              {!results.length && <p>Ainda não existem resultados.</p>}
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
                      Visualizar
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => void openResult(result, true)}
                    >
                      Descarregar
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
