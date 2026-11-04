// FILE: HtmlFilePreview.tsx
// Purpose: Renders an HTML file in a sandboxed iframe served by the server's
//          folder-scoped HTML preview route. The server streams the file, so
//          previews have no size limit, and they work in remote SSH windows
//          because the host's server reads its own files.
// Layer: Web chat/editor file-preview component
// Exports: HtmlFilePreview

import { describeErrorMessage } from "@saint/shared/errorMessages";
import { HTML_PREVIEW_ROUTE_PATH } from "@saint/shared/localPreviewFiles";
import { useQuery } from "@tanstack/react-query";

import { LOCAL_HOST_ID } from "@saint/shared/hostId";

import { apiFor, useHostId } from "~/hosts/hostScope";
import { readLocalNativeApi } from "~/nativeApi";
import { resolveHostHttpUrl } from "~/lib/wsHttpUrl";
import { PanelStateMessage } from "./chat/PanelStateMessage";

// Same capabilities as the response's CSP sandbox; never allow-same-origin, so
// the page cannot reach the app's storage or the server's cookies.
const HTML_PREVIEW_SANDBOX = "allow-scripts allow-forms allow-popups allow-modals allow-downloads";

export function HtmlFilePreview(props: {
  /** Absolute path of the HTML file on the server's machine. */
  absolutePath: string;
  /** Changes on reload so the frame fetches the file again. */
  cacheKey: string | number;
}) {
  // A remote host's chat previews the file on that host's server, grant included.
  const hostId = useHostId();
  const grantQuery = useQuery({
    queryKey: ["projects", "html-preview-grant", props.absolutePath, props.cacheKey, hostId],
    queryFn: async () => {
      const api = hostId === LOCAL_HOST_ID ? readLocalNativeApi() : apiFor(hostId);
      const createGrant = api?.projects.createHtmlPreviewGrant;
      if (!createGrant) throw new Error("Update the Saint server to preview HTML files.");
      return createGrant({ path: props.absolutePath });
    },
    retry: false,
    staleTime: Infinity,
  });

  if (grantQuery.isError) {
    return (
      <PanelStateMessage density="compact" fill="flex" className="items-start justify-start p-3">
        <p className="text-left text-ui-sm text-destructive/85">
          {describeErrorMessage(
            grantQuery.error,
            "Could not open the HTML preview. The Saint server may be out of date.",
          )}
        </p>
      </PanelStateMessage>
    );
  }
  if (!grantQuery.data) return null;

  const srcUrl = new URL(
    resolveHostHttpUrl(
      hostId,
      `${HTML_PREVIEW_ROUTE_PATH}/${grantQuery.data.grant}/${encodeURIComponent(grantQuery.data.entryName)}`,
    ),
    window.location.href,
  );
  // The grant in the path authorizes the route; the server token must never
  // reach the page, whose scripts can read their own URL.
  srcUrl.searchParams.delete("token");
  const src = srcUrl.toString();
  return (
    <iframe
      key={src}
      title={grantQuery.data.entryName}
      src={src}
      sandbox={HTML_PREVIEW_SANDBOX}
      referrerPolicy="no-referrer"
      className="min-h-0 w-full flex-1 border-0 bg-white"
    />
  );
}
