type RpcError = { code?: string; message?: string };

/** Deletion has no generated reply or newly saved writing to recover. */
export function projectDeletionError(
  error: RpcError,
  subject: "chat" | "source",
) {
  if (error.code === "PT409")
    return {
      status: 409,
      error: `The project changed. Reopen it before deleting this ${subject}.`,
    };
  if (error.code === "PT425")
    return {
      status: 409,
      error: `A reply or voice session is still being checked. Try deleting this ${subject} once it finishes.`,
    };
  if (error.code === "P0002")
    return {
      status: 404,
      error: `This ${subject} is no longer available. Reopen the project to check.`,
    };
  if (error.code === "28000")
    return { status: 401, error: `Sign in again to delete this ${subject}.` };
  if (error.code === "42501")
    return {
      status: 403,
      error: `This account cannot delete this ${subject}.`,
    };
  if (
    error.code === "PGRST202" ||
    error.code === "42883" ||
    (error.code === "22023" &&
      /^(Unknown planning command|Invalid source command)$/.test(
        error.message || "",
      ))
  )
    return {
      status: 503,
      error: `${subject === "chat" ? "Chat" : "Source"} deletion is temporarily unavailable. Please try again later.`,
    };
  if (error.code === "22023")
    return {
      status: 422,
      error: `This ${subject} could not be deleted. Reopen the project and try again.`,
    };
  return {
    status: 503,
    error: `${subject === "chat" ? "Chat" : "Source"} deletion could not be confirmed. Reopen the project to check before trying again.`,
  };
}
