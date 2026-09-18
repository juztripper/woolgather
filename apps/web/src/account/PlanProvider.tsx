import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useRef,
  type ReactNode,
} from "react";
import { api } from "../client";
import {
  planSnapshotSchema,
  type PlanSnapshot,
} from "../../../../packages/domain/src/plans";

const PlanContext = createContext<{
  plan?: PlanSnapshot;
  error: string;
  loading: boolean;
  refresh: () => Promise<void>;
}>({ error: "", loading: false, refresh: async () => {} });
export const usePlan = () => useContext(PlanContext);
export function openPlan() {
  window.dispatchEvent(new Event("woolgather:open-plan"));
}
export function PlanProvider({ children }: { children: ReactNode }) {
  const [plan, setPlan] = useState<PlanSnapshot>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++revision.current;
    try {
      const result = planSnapshotSchema.parse(await api("/plan"));
      if (revision.current === current) {
        setPlan(result);
        setError("");
      }
    } catch (error) {
      if (revision.current === current) setError((error as Error).message);
    } finally {
      if (revision.current === current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const update = () => void refresh();
    window.addEventListener("woolgather:plan-changed", update);
    window.addEventListener("focus", update);
    return () => {
      revision.current++;
      window.removeEventListener("woolgather:plan-changed", update);
      window.removeEventListener("focus", update);
    };
  }, [refresh]);
  return (
    <PlanContext.Provider value={{ plan, error, loading, refresh }}>
      {children}
    </PlanContext.Provider>
  );
}
