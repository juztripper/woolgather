import { createContext } from "react";
import { api } from "../client";

// Production uses the authenticated API. Browser fixtures supply isolated storage.
export const IdeaLibraryTransport = createContext(api);
