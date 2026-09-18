import { api, ApiError, connect } from "../client";
import {
  attachmentScheme,
  legacyImageScheme,
  attachmentLimit,
} from "../../../../packages/domain/src/ideaBlocks";
export async function attachmentRequest(
  id: string,
  file?: File,
): Promise<Response> {
  if (file && file.size > attachmentLimit)
    throw new Error("Choose a file no larger than 20 MB.");
  const {
    data: { session },
  } = await (await connect()).auth.getSession();
  if (!session)
    throw new ApiError("Sign in again to add or open this file.", 401);
  const response = await fetch(
    "/api/attachments/" +
      id +
      (file ? "?name=" + encodeURIComponent(file.name) : ""),
    {
      method: file ? "POST" : "GET",
      headers: { Authorization: "Bearer " + session.access_token },
      body: file,
      signal: AbortSignal.timeout(90000),
    },
  );
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as {
      error?: string;
      accountAccess?: string;
    };
    if (data.accountAccess)
      window.dispatchEvent(new Event("woolgather:account-access"));
    throw new ApiError(
      data.error || "Unable to transfer this file. Please retry.",
      response.status,
    );
  }
  return response;
}
export async function attachmentBlob(url: string): Promise<Blob> {
  if (url.startsWith(attachmentScheme))
    return (await attachmentRequest(url.slice(attachmentScheme.length))).blob();
  if (url.startsWith(legacyImageScheme)) {
    const { dataUrl } = await api<{ dataUrl: string }>(
      "/images/" + url.slice(legacyImageScheme.length),
    );
    return (await fetch(dataUrl)).blob();
  }
  throw new Error("This file reference is not supported.");
}
