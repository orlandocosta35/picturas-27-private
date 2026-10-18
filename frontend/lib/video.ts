import { api } from "./axios";

export type VideoResizeTask = {
  id: string;
  status: "queued" | "processing" | "completed" | "failed";
  progress: number;
  error?: string;
  downloadName?: string;
};

export async function createVideoResizeTask(
  userId: string,
  token: string,
  file: File,
  params: {
    width: number;
    height: number;
    resizeMode: string;
    outputFormat: string;
  },
) {
  const body = new FormData();
  body.append("video", file);
  Object.entries(params).forEach(([key, value]) => body.append(key, String(value)));
  const response = await api.post<VideoResizeTask>(
    `/projects/${userId}/video-mvp/video/resize`,
    body,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return response.data;
}

export async function getVideoResizeTask(userId: string, token: string, taskId: string) {
  const response = await api.get<VideoResizeTask>(
    `/projects/${userId}/video-mvp/video/tasks/${taskId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return response.data;
}

export async function downloadVideoResizeTask(userId: string, token: string, taskId: string) {
  const response = await api.get<Blob>(
    `/projects/${userId}/video-mvp/video/tasks/${taskId}/download`,
    { headers: { Authorization: `Bearer ${token}` }, responseType: "blob" },
  );
  return response.data;
}
