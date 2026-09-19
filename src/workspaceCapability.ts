import type { Env, WorkState } from "./types";
import { aiJson } from "./ai";
import { getActiveWorkId, getSessionStub, newWorkId, setActiveWorkId } from "./router";
import { sendConversationHatMessage } from "./telegram";
import { presentGoogleAccountPicker } from "./googleOAuth";

export interface WorkspaceCapabilityResult {
  isCapability: boolean;
  capability?: "google_doc";
  title?: string;
  content?: string;
  missingField?: "title" | "content" | "both";
}

export async function classifyWorkspaceCapability(
  env: Env,
  text: string,
): Promise<WorkspaceCapabilityResult> {
  const result = await aiJson<{
    is_capability_request: boolean;
    capability_type?: "google_doc";
    title?: string;
    content?: string;
  }>(env, {
    taskId: "routing.workspace_capability_check",
    system: `You analyze incoming user requests for ENIG to identify if the request is asking for a Workspace execution capability (specifically, creating a Google Doc or Google Document).

If the request is asking to create a Google Doc/Document:
- Set is_capability_request to true.
- Set capability_type to "google_doc".
- Extract the document title if explicitly provided in the request (e.g., 'titled "X"', 'named "Y"', or clearly indicated as the title). If missing or ambiguous, leave title as null.
- Extract the document content if provided in the request (e.g., 'with content: Z', 'containing "Z"'). If missing or ambiguous, leave content as null.

Do NOT invent or infer missing titles or content.
If the request is NOT asking to create a document or Workspace capability, set is_capability_request to false.

Return JSON: {"is_capability_request": boolean, "capability_type": "google_doc", "title": string|null, "content": string|null}`,
    user: text,
    light: true,
  });

  if (!result || !result.is_capability_request || result.capability_type !== "google_doc") {
    return { isCapability: false };
  }

  const title = result.title?.trim() || undefined;
  const content = result.content?.trim() || undefined;

  let missingField: "title" | "content" | "both" | undefined;
  if (!title && !content) missingField = "both";
  else if (!title) missingField = "title";
  else if (!content) missingField = "content";

  return {
    isCapability: true,
    capability: "google_doc",
    title,
    content,
    missingField,
  };
}

export async function handleWorkspaceCapabilityRequest(
  env: Env,
  chatId: number,
  text: string,
  threadId?: number,
): Promise<boolean> {
  const activeWorkIdCheck = await getActiveWorkId(env, chatId, threadId);
  if (activeWorkIdCheck) {
    const stubCheck = getSessionStub(env, activeWorkIdCheck);
    const stateCheck = await stubCheck.getState();
    if (stateCheck && stateCheck.awaiting === "google_doc_input") {
      await stubCheck.handleTextReply(text);
      return true;
    }
  }

  const capResult = await classifyWorkspaceCapability(env, text);
  if (!capResult.isCapability || capResult.capability !== "google_doc") {
    return false;
  }

  // Identify or create single canonical WorkSession
  const activeWorkId = await getActiveWorkId(env, chatId, threadId);
  let workId: string;
  let stub: any;
  let state: WorkState | undefined;

  if (activeWorkId) {
    workId = activeWorkId;
    stub = getSessionStub(env, workId);
    state = await stub.getState();
  }

  if (!state) {
    workId = newWorkId();
    stub = getSessionStub(env, workId);
    await stub.init(workId, chatId, undefined, undefined, threadId);
    await setActiveWorkId(env, chatId, threadId, workId);
    state = await stub.getState();
  }

  if (!state) return false;

  // Handle missing title / content
  if (capResult.missingField) {
    state.awaiting = "google_doc_input";
    if (capResult.title) state.marketingTaskText = `TITLE:${capResult.title}`;
    else if (capResult.content) state.marketingTaskText = `CONTENT:${capResult.content}`;

    let promptMsg = "";
    if (capResult.missingField === "title") {
      promptMsg = "Please provide the document title for your Google Doc creation request.";
    } else if (capResult.missingField === "content") {
      promptMsg = `Please provide the document content for "${capResult.title}".`;
    } else {
      promptMsg = "Please provide both the document title and content for your Google Doc creation request.";
    }

    await sendConversationHatMessage(env, state, promptMsg);
    return true;
  }

  // Both title and content present -> proceed directly to account picker
  await presentGoogleAccountPicker(env, state, capResult.title!, capResult.content!);
  return true;
}

export async function handleGoogleDocInputReply(
  env: Env,
  state: WorkState,
  text: string,
): Promise<WorkState> {
  let title: string | undefined;
  let content: string | undefined;

  const storedText = state.marketingTaskText || "";
  if (storedText.startsWith("TITLE:")) {
    title = storedText.replace("TITLE:", "").trim();
    content = text.trim();
  } else if (storedText.startsWith("CONTENT:")) {
    content = storedText.replace("CONTENT:", "").trim();
    title = text.trim();
  } else {
    // Both were missing, parse response or assume user gave "Title: ... Content: ..."
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length >= 2) {
      title = lines[0];
      content = lines.slice(1).join("\n");
    } else {
      title = text.trim();
    }
  }

  if (!title || !content) {
    if (!title) {
      state.awaiting = "google_doc_input";
      state.marketingTaskText = content ? `CONTENT:${content}` : "";
      await sendConversationHatMessage(env, state, "Please provide the document title.");
      return state;
    }
    if (!content) {
      state.awaiting = "google_doc_input";
      state.marketingTaskText = `TITLE:${title}`;
      await sendConversationHatMessage(env, state, `Please provide the document content for "${title}".`);
      return state;
    }
  }

  state.awaiting = undefined;
  state.marketingTaskText = undefined;

  await presentGoogleAccountPicker(env, state, title, content);
  return state;
}
