import { useQuery, QueryClient } from "@tanstack/react-query";

export const client = new QueryClient({
  defaultOptions: { queries: { cacheTime: 1000 } },
});

export function useUser(id: string) {
  return useQuery(
    ["user", id],
    () => fetch(`/u/${id}`).then((r) => r.json() as Promise<{ name: string }>),
    { cacheTime: 5000 },
  );
}
