import { api } from "./axios";

/*
 * Resize quota is reserved by the video service after it verifies the
 * authenticated profile and associates the reservation with the task.
 */
/*
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
*/

export type ResizeMode = "contain" | "cover" | "stretch";
export type VideoOutputFormat = "mp4" | "webm";
export type VideoTaskError = {
  code: string;
  message: string;
  retryable: boolean;
};

export type VideoResizeTask = {
  id: string;
  status: "queued" | "processing" | "completed" | "failed" | "cancelled";
  progress: number;
  stage?: "queued" | "encoding" | "saving" | "completed" | "failed" | "cancelled";
  message?: string;
  error?: VideoTaskError | string | null;
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
    resizeMode: ResizeMode;
    outputFormat: VideoOutputFormat;
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

export async function cancelVideoResizeTask(
  userId: string,
  projectId: string,
  token: string,
  taskId: string,
) {
  const response = await api.delete<VideoResizeTask>(
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
  error?: string;
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
  size?: number;
  // Only present in concatenation results (number of joined videos).
  inputs?: number;
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

// UC-VID-005: concatenation.
// One field of the RN7 compatibility check, in the order the service compares them.
export type CompatibilityField = { field: string; label: string; value: string };
export type VideoLibraryItem = {
  projectId: string;
  projectName: string;
  name: string;
  mimeType: string;
  // Metadata (REQ-VID-CON-007); absent when the video could not be read.
  duration?: number;
  size?: number;
  container?: string;
  width?: number;
  height?: number;
  fps?: number;
  videoCodec?: string;
  hasAudio?: boolean;
  audioCodec?: string | null;
  compatibility?: CompatibilityField[];
  error?: string;
  code?: string;
};
export type VideoConcatTask = {
  id: string;
  status: VideoResizeTask["status"];
  progress: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  downloadName: string;
  outputFormat: string;
  inputs: Array<{ name: string; duration: number }>;
  expectedDuration: number;
  error?: string;
  errorCode?: string;
  result?: {
    duration: number;
    width: number;
    height: number;
    fps: number;
    size: number;
    hasAudio: boolean;
    inputs: number;
  };
};
export async function listVideoLibrary(
  user: string,
  project: string,
  token: string,
) {
  return (
    await api.get<VideoLibraryItem[]>(
      `${trimPath(user, project)}/concat/library`,
      { headers: credentials(token) },
    )
  ).data;
}
export async function createVideoConcatTask(
  user: string,
  project: string,
  token: string,
  videos: string[],
) {
  return (
    await api.post<VideoConcatTask>(
      `${trimPath(user, project)}/concat`,
      { videos },
      { headers: credentials(token) },
    )
  ).data;
}
export async function getVideoConcatTask(
  user: string,
  project: string,
  token: string,
  id: string,
) {
  return (
    await api.get<VideoConcatTask>(
      `${trimPath(user, project)}/concat/tasks/${id}`,
      { headers: credentials(token) },
    )
  ).data;
}
export async function listVideoConcatTasks(
  user: string,
  project: string,
  token: string,
) {
  return (
    await api.get<VideoConcatTask[]>(`${trimPath(user, project)}/concat/tasks`, {
      headers: credentials(token),
    })
  ).data;
}
export async function cancelVideoConcatTask(
  user: string,
  project: string,
  token: string,
  id: string,
) {
  return (
    await api.delete<VideoConcatTask>(
      `${trimPath(user, project)}/concat/tasks/${id}`,
      { headers: credentials(token) },
    )
  ).data;
}
