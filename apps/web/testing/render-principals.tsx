// Renders the production Principal view with its production action callbacks.
import { renderToStaticMarkup } from "react-dom/server";
import type { PrincipalsClient } from "../client/principals.ts";
import { PrincipalsView } from "../screens/principals.tsx";

export function renderPrincipals(client: PrincipalsClient): string {
  return renderToStaticMarkup(<PrincipalsView state={client.getSnapshot()} actions={client} />);
}
