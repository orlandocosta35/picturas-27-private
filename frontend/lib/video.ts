import { api } from "./axios";

export async function reserveVideoOperation(userId: string, token: string) {
  await api.get(`/users/${userId}/process/1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function refundVideoOperation(userId: string, token: string) {
  await api.post(`/users/${userId}/process/refund/1`, null, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export type VideoResizeTask = {
  id: string;
  status: "queued" | "processing" | "completed" | "failed";
  progress: number;
  error?: string;
  downloadName?: string;
};

export async function createVideoResizeTask(
  userId: string,
  projectId: string,
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
    `/projects/${userId}/${projectId}/video/resize`,
    body,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return response.data;
}

export async function getVideoResizeTask(userId: string, projectId: string, token: string, taskId: string) {
  const response = await api.get<VideoResizeTask>(
    `/projects/${userId}/${projectId}/video/tasks/${taskId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return response.data;
}

export async function downloadVideoResizeTask(userId: string, projectId: string, token: string, taskId: string) {
  const response = await api.get<Blob>(
    `/projects/${userId}/${projectId}/video/tasks/${taskId}/download`,
    { headers: { Authorization: `Bearer ${token}` }, responseType: "blob" },
  );
  return response.data;
}
