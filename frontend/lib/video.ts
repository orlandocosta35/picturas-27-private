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
  Object.entries(params).forEach(([key, value]) =>
    body.append(key, String(value)),
  );
  const response = await api.post<VideoResizeTask>(
    `/projects/${userId}/${projectId}/video/resize`,
    body,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return response.data;
}

export async function getVideoResizeTask(
  userId: string,
  projectId: string,
  token: string,
  taskId: string,
) {
  const response = await api.get<VideoResizeTask>(
    `/projects/${userId}/${projectId}/video/tasks/${taskId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return response.data;
}

export async function downloadVideoResizeTask(
  userId: string,
  projectId: string,
  token: string,
  taskId: string,
) {
  const response = await api.get<Blob>(
    `/projects/${userId}/${projectId}/video/tasks/${taskId}/download`,
    { headers: { Authorization: `Bearer ${token}` }, responseType: "blob" },
  );
  return response.data;
}

export type TrimMode = "fast" | "precise";
export type TrimPlan = {
  status: "confirmation_required" | "no_changes" | "ready";
  mode: TrimMode;
  requestedStartSeconds: number;
  requestedEndSeconds: number;
  effectiveStartSeconds: number;
  effectiveEndSeconds: number;
};
export type VideoTrimTask = Omit<VideoResizeTask, "status"> & {
  status: VideoResizeTask["status"] | "cancelled";
  effectiveStartSeconds: number;
  effectiveEndSeconds: number;
  mode: TrimMode;
  startedAt?: string;
  finishedAt?: string;
};
export type VideoResult = {
  id: string;
  name: string;
  format: string;
  createdAt: string;
  duration: number;
};
const trimPath = (user: string, project: string) =>
  `/projects/${user}/${project}/video`;
const credentials = (token: string) => ({ Authorization: `Bearer ${token}` });
export async function createVideoTrimTask(
  user: string,
  project: string,
  token: string,
  startSeconds: number,
  endSeconds: number,
  mode: TrimMode,
) {
  return (
    await api.post<VideoTrimTask | TrimPlan>(
      `${trimPath(user, project)}/trim`,
      { startSeconds, endSeconds, mode },
      { headers: credentials(token) },
    )
  ).data;
}
export async function getVideoTrimTask(
  user: string,
  project: string,
  token: string,
  id: string,
) {
  return (
    await api.get<VideoTrimTask>(
      `${trimPath(user, project)}/trim/tasks/${id}`,
      { headers: credentials(token) },
    )
  ).data;
}
export async function listVideoTrimTasks(
  user: string,
  project: string,
  token: string,
) {
  return (
    await api.get<VideoTrimTask[]>(`${trimPath(user, project)}/trim/tasks`, {
      headers: credentials(token),
    })
  ).data;
}
export async function cancelVideoTrimTask(
  user: string,
  project: string,
  token: string,
  id: string,
) {
  return (
    await api.delete<VideoTrimTask>(
      `${trimPath(user, project)}/trim/tasks/${id}`,
      { headers: credentials(token) },
    )
  ).data;
}
export async function listVideoResults(
  user: string,
  project: string,
  token: string,
) {
  return (
    await api.get<VideoResult[]>(`${trimPath(user, project)}/results`, {
      headers: credentials(token),
    })
  ).data;
}
export async function downloadVideoResult(
  user: string,
  project: string,
  token: string,
  id: string,
) {
  return (
    await api.get<Blob>(`${trimPath(user, project)}/results/${id}/download`, {
      headers: credentials(token),
      responseType: "blob",
    })
  ).data;
}
