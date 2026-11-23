import { useIsFetching } from "@tanstack/react-query";

import { useUser } from "./queries";

export function App() {
  const { data, isLoading } = useUser("1");
  const fetching = useIsFetching(["user"]);
  if (isLoading) return <p>loading {fetching}</p>;
  return <p>{data?.name}</p>;
}
