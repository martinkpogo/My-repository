/**
 * List ONE Google Drive folder's direct contents (My Drive only).
 *
 * This is the first building block of the Telegram Drive file browser: open a
 * folder, see its subfolders and files. It deliberately makes EXACTLY ONE
 * Drive request and never follows nextPageToken -- when Drive reports more
 * pages the caller gets `truncated: true` and decides what to do about it
 * (no shared-drive or "shared with me" support: no supportsAllDrives,
 * includeItemsFromAllDrives or corpora parameters).
 *
 * Nothing in production calls this yet; it is wired into the folder picker in
 * a later task.
 */

export interface DriveItem {
  id: string;
  name: string;
  kind: "folder" | "file";
  mimeType: string;
  webViewLink?: string;
}

export type ListDriveFolderContentsResult =
  | { ok: true; items: DriveItem[]; truncated: boolean }
  | { ok: false; reason: "invalid_parent" | "http" | "network" | "malformed"; status?: number };

export type GetMyDriveRootResult =
  | { ok: true; id: string; name: string }
  | { ok: false; reason: "http" | "network" | "malformed"; status?: number };

/** Drive ids are URL-safe base64url; anything else is rejected fail-closed. */
const PARENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

/**
 * List the direct children of one Drive folder in a single request.
 *
 * Never throws: every failure mode is returned as `{ ok: false, reason }`
 * (invalid parent id, non-2xx HTTP, network error, malformed body). No
 * logging, no KV, no Telegram -- the caller decides how to surface errors.
 */
export async function listDriveFolderContents(
  accessToken: string,
  parentId: string,
): Promise<ListDriveFolderContentsResult> {
  // Validate BEFORE any fetch: a malformed parent id must not reach Drive.
  if (!PARENT_ID_PATTERN.test(parentId)) {
    return { ok: false, reason: "invalid_parent" };
  }

  // URLSearchParams handles all percent-encoding; no hand-written encoding.
  const query = new URLSearchParams({
    q: `'${parentId}' in parents and trashed=false`,
    orderBy: "folder,name",
    pageSize: "1000",
    fields: "files(id,name,mimeType,webViewLink),nextPageToken",
  });
  const url = `https://www.googleapis.com/drive/v3/files?${query.toString()}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
  } catch {
    return { ok: false, reason: "network" };
  }

  if (!res.ok) {
    return { ok: false, reason: "http", status: res.status };
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (typeof data !== "object" || data === null) {
    return { ok: false, reason: "malformed" };
  }
  const body = data as Record<string, unknown>;

  // A missing `files` key is a normal empty listing, not an error.
  if (!("files" in body)) {
    return { ok: true, items: [], truncated: false };
  }
  if (!Array.isArray(body.files)) {
    return { ok: false, reason: "malformed" };
  }

  const items: DriveItem[] = [];
  for (const entry of body.files) {
    if (typeof entry !== "object" || entry === null) continue;
    const file = entry as Record<string, unknown>;
    // Only id and name are required; anything else lacking either is skipped.
    if (typeof file.id !== "string" || typeof file.name !== "string") continue;
    const mimeType = typeof file.mimeType === "string" ? file.mimeType : "";
    items.push({
      id: file.id,
      name: file.name,
      // A folder ONLY when the mime type says so; shortcuts and everything
      // else count as files.
      kind: mimeType === FOLDER_MIME_TYPE ? "folder" : "file",
      mimeType,
      ...(typeof file.webViewLink === "string" ? { webViewLink: file.webViewLink } : {}),
    });
  }

  // Drive already ordered by folder,name, but sort locally too so the
  // guarantee holds regardless of what the API returns: folders first, then
  // files; A-Z within each group, case-insensitive.
  items.sort((a, b) => {
    const rank = (item: DriveItem): number => (item.kind === "folder" ? 0 : 1);
    const byKind = rank(a) - rank(b);
    if (byKind !== 0) return byKind;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  // nextPageToken is reported but NEVER followed -- one request, always.
  const truncated = body.nextPageToken !== undefined && body.nextPageToken !== null;
  return { ok: true, items, truncated };
}

/**
 * Resolve My Drive's REAL folder id in exactly one Drive request.
 *
 * Google accepts the shortcut id "root" for My Drive, but binding approval
 * to "root" would give the same folder two identities ("root" and its real
 * id) in approvals and logs. This returns the real id so the save step can
 * bind to a single, stable identity. Nothing in production calls this yet.
 *
 * Never throws: every failure mode is returned as `{ ok: false, reason }`
 * (non-2xx HTTP, network error, malformed body). No logging, no KV, no
 * Telegram -- the caller decides how to surface errors.
 */
export async function getMyDriveRoot(
  accessToken: string,
): Promise<GetMyDriveRootResult> {
  const url = "https://www.googleapis.com/drive/v3/files/root?fields=id,name";

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
  } catch {
    return { ok: false, reason: "network" };
  }

  if (!res.ok) {
    return { ok: false, reason: "http", status: res.status };
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (typeof data !== "object" || data === null) {
    return { ok: false, reason: "malformed" };
  }
  const body = data as Record<string, unknown>;

  const id = body.id;
  if (
    typeof id !== "string" ||
    !PARENT_ID_PATTERN.test(id) ||
    id === "root"
  ) {
    return { ok: false, reason: "malformed" };
  }

  const name =
    typeof body.name === "string" && body.name.length > 0
      ? body.name
      : "My Drive";

  return { ok: true, id, name };
}
