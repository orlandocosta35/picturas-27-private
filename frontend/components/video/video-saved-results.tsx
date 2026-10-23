"use client";

import { useEffect, useState } from "react";
import { Download, FolderDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  downloadVideoResult,
  listVideoResults,
  VideoResult,
} from "@/lib/video";

function message(error: unknown) {
  const e = error as { response?: { data?: { error?: string } } };
  return (
    e.response?.data?.error ||
    "Could not contact the service. Please try again."
  );
}

export function VideoSavedResults({
  userId,
  projectId,
  token,
}: {
  userId?: string;
  projectId?: string;
  token?: string;
}) {
  const [results, setResults] = useState<VideoResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!userId || !projectId || !token) {
      setLoading(false);
      return;
    }
    let disposed = false;
    setLoading(true);
    listVideoResults(userId, projectId, token)
      .then((saved) => {
        if (!disposed) {
          setResults(saved);
          setError(null);
        }
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

  async function download(result: VideoResult) {
    if (!userId || !projectId || !token) return;
    try {
      const blob = await downloadVideoResult(
        userId,
        projectId,
        token,
        result.id,
      );
      const object = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = object;
      link.download = result.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(object), 1000);
    } catch (e) {
      setError(message(e));
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Saved results</h1>
        <p className="mt-2 text-muted-foreground">
          Download the videos and frame archives saved in this project.
        </p>
      </div>
      {!userId || !projectId || !token ? (
        <p>Open a video project to view its saved results.</p>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FolderDown className="size-5" />
              Project results
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {loading && (
              <p className="text-sm text-muted-foreground">
                Loading saved results...
              </p>
            )}
            {!loading && !results.length && (
              <p className="text-sm text-muted-foreground">
                No saved results yet.
              </p>
            )}
            {results.map((result) => (
              <div
                key={result.id}
                className="flex flex-wrap items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <p className="break-all">{result.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(result.createdAt).toLocaleString()}
                  </p>
                </div>
                <Button variant="outline" onClick={() => void download(result)}>
                  <Download className="size-4" />
                  Download
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </div>
  );
}
