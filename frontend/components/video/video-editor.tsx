"use client";

import {
  Check,
  Film,
  LoaderCircle,
  Play,
  Scissors,
  Upload,
  X,
} from "lucide-react";
import { ChangeEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";

type VideoOperation = "resize" | "trim";
type VideoMetadata = {
  duration: number;
  width: number;
  height: number;
};

const ACCEPTED_VIDEO_TYPES = ["video/mp4", "video/webm", "video/quicktime"];

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds)) return "--:--";
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function VideoEditor() {
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
  const [keepAspectRatio, setKeepAspectRatio] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      if (progressTimerRef.current !== null) {
        window.clearInterval(progressTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (metadata) setEndSeconds(metadata.duration);
  }, [metadata]);

  const handleFile = (selectedFile: File | undefined) => {
    if (!selectedFile) return;
    if (!ACCEPTED_VIDEO_TYPES.includes(selectedFile.type)) {
      setError("Escolhe um vídeo MP4, WebM ou MOV.");
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

  const handleProcess = () => {
    if (!file || !metadata) return;
    if (operation === "trim" && endSeconds <= startSeconds) {
      setError("O fim do recorte deve ser posterior ao início.");
      return;
    }
    if (operation === "resize" && (width < 1 || height < 1)) {
      setError("A resolução deve ter valores positivos.");
      return;
    }

    setError(null);
    setProgress(0);
    progressTimerRef.current = window.setInterval(() => {
      setProgress((current) => {
        if (current === null || current >= 100) {
          if (progressTimerRef.current !== null) {
            window.clearInterval(progressTimerRef.current);
            progressTimerRef.current = null;
          }
          return 100;
        }
        return Math.min(current + 10, 100);
      });
    }, 120);
  };

  const maxDuration = metadata?.duration ?? 1;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <div>
        <p className="text-sm font-medium text-primary">Fase 1 · MVP</p>
        <h1 className="text-3xl font-bold tracking-tight">Tratamento de vídeo</h1>
        <p className="mt-2 text-muted-foreground">
          Seleciona um vídeo, configura uma operação e valida o fluxo antes de
          ligar o processamento FFmpeg.
        </p>
      </div>

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
              <p className="font-medium">Carrega um vídeo para começar</p>
              <p className="mt-1 text-sm text-muted-foreground">
                MP4, WebM ou MOV
              </p>
            </div>
            <Button type="button" variant="outline">
              Escolher vídeo
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
                    : "A ler metadados..."}
                </CardDescription>
              </div>
              <Button
                aria-label="Remover vídeo"
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
              <CardTitle>Operação</CardTitle>
              <CardDescription>
                Escolhe uma operação para configurar.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant={operation === "trim" ? "default" : "outline"}
                  className="h-auto justify-start gap-2 py-3"
                  onClick={() => setOperation("trim")}
                >
                  <Scissors className="size-4" />
                  Recortar
                </Button>
                <Button
                  variant={operation === "resize" ? "default" : "outline"}
                  className="h-auto justify-start gap-2 py-3"
                  onClick={() => setOperation("resize")}
                >
                  <Film className="size-4" />
                  Redimensionar
                </Button>
              </div>

              {operation === "trim" ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="trim-start">Início (segundos)</Label>
                      <Input
                        id="trim-start"
                        type="number"
                        min={0}
                        max={Math.max(0, endSeconds - 0.1)}
                        step={0.1}
                        value={startSeconds}
                        onChange={(event) =>
                          setStartSeconds(Number(event.target.value))
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="trim-end">Fim (segundos)</Label>
                      <Input
                        id="trim-end"
                        type="number"
                        min={Math.min(maxDuration, startSeconds + 0.1)}
                        max={maxDuration}
                        step={0.1}
                        value={endSeconds}
                        onChange={(event) =>
                          setEndSeconds(Number(event.target.value))
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
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="video-width">Largura</Label>
                      <Input
                        id="video-width"
                        type="number"
                        min={1}
                        value={width}
                        onChange={(event) => setWidth(Number(event.target.value))}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="video-height">Altura</Label>
                      <Input
                        id="video-height"
                        type="number"
                        min={1}
                        value={height}
                        onChange={(event) => setHeight(Number(event.target.value))}
                      />
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={keepAspectRatio}
                      onChange={(event) => setKeepAspectRatio(event.target.checked)}
                      className="size-4 accent-primary"
                    />
                    Manter relação de aspeto
                  </label>
                </div>
              )}

              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}

              {progress !== null && (
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span>
                      {progress === 100 ? "Pré-visualização concluída" : "A processar..."}
                    </span>
                    <span>{progress}%</span>
                  </div>
                  <Progress value={progress} />
                </div>
              )}

              <Button
                className="w-full gap-2"
                onClick={handleProcess}
                disabled={!metadata || progress !== null && progress < 100}
              >
                {progress !== null && progress < 100 ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : progress === 100 ? (
                  <Check className="size-4" />
                ) : (
                  <Play className="size-4" />
                )}
                {progress === 100 ? "Concluído" : "Processar vídeo"}
              </Button>
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
}
